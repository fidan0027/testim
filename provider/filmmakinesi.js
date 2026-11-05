/**
 * Film Makinesi - Nuvio yerel kazıyıcı (scraper)
 * findMovie.php içindeki filmmakinesi_findMovie() mantığının JavaScript karşılığı.
 * Sunucu/proxy gerekmez: Referer vb. başlıklar akışın "headers" alanıyla oynatıcıya verilir.
 *
 * KURULUM: aşağıdaki TMDB_API_KEY değerini kendi (ücretsiz) TMDB API anahtarınla değiştir.
 */
var TMDB_API_KEY = '52865b1ad0b830f4f86c631509688556';

// true: bir hata olursa akış listesinde "HATA: ..." satırı gösterilir (sorun giderme için). Çalışınca false yap.
var DEBUG = true;

var BASE = 'https://filmmakinesi.to';
var CLOSE = 'https://closeload.filmmakinesi.to';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ---------------------------------------------------------------- HTTP
function pageHeaders(referer) {
  return {
    'accept': '*/*',
    'accept-language': 'tr,en-US;q=0.9,en;q=0.8',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'referer': referer + '/',
    'user-agent': UA,
    'x-requested-with': 'XMLHttpRequest'
  };
}

function httpGet(url, referer) {
  return fetch(url, { method: 'GET', headers: pageHeaders(referer) }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return r.text();
  });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function absolutize(u) {
  u = decodeEntities(String(u).replace(/\\/g, '')).replace(/^\s+|\s+$/g, '');
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (/^https?:\/\//i.test(u)) return u;
  return BASE + '/' + u.replace(/^\/+/, '');
}

// ---------------------------------------------------------------- Player çözücü (PHP decodePlayerDynamic portu)
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64decodeBinary(input) {
  var s = String(input).replace(/=+$/, '');
  if (/[^A-Za-z0-9+\/]/.test(s) || s.length % 4 === 1) throw new Error('gecersiz base64');
  var out = '', buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    buf = (buf << 6) | B64.indexOf(s.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 255);
      buf &= (1 << bits) - 1;
    }
  }
  return out;
}

function utf8FromBinary(bin) {
  try { return decodeURIComponent(bin.replace(/[\s\S]/g, function (c) { return '%' + ('0' + c.charCodeAt(0).toString(16)).slice(-2); })); }
  catch (e) { return bin; }
}

function jsUnescape(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, function (m, c) {
    if (c.charAt(0) === 'x' || c.charAt(0) === 'u') return String.fromCharCode(parseInt(c.slice(1), 16));
    var map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
    return map.hasOwnProperty(c) ? map[c] : c;
  });
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function matchClose(s, i, openCh, closeCh) {
  var depth = 0, q = null, escp = false;
  for (var j = i; j < s.length; j++) {
    var c = s.charAt(j);
    if (q) {
      if (escp) escp = false;
      else if (c === '\\') escp = true;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

function rot(text, shift) {
  var o = '';
  for (var k = 0; k < text.length; k++) {
    var d = text.charCodeAt(k);
    if (d >= 65 && d <= 90) o += String.fromCharCode((d - 65 + shift) % 26 + 65);
    else if (d >= 97 && d <= 122) o += String.fromCharCode((d - 97 + shift) % 26 + 97);
    else o += text.charAt(k);
  }
  return o;
}

function decodeParts(parts, jsBody) {
  var value = parts.join('');
  var m;
  var keyVar = (jsBody.match(/for\s*\([^;]+;\s*[^;]*<\s*([a-zA-Z_$][\w$]*)\.length\s*;/) || [])[1];
  var opsVar = (jsBody.match(/for\s*\([^=]+=\s*([a-zA-Z_$][\w$]*)\.length\s*-\s*1\s*;[^;]+>=\s*0\s*;/) || [])[1];

  function readVar(n) {
    if (!n) return null;
    var r = jsBody.match(new RegExp('\\b(?:var|let|const)\\s+' + esc(n) + '\\s*=\\s*(["\'])((?:\\\\[\\s\\S]|(?!\\1)[^\\\\])*)\\1\\s*;'));
    return r ? jsUnescape(r[2]) : null;
  }
  var key = readVar(keyVar), ops = readVar(opsVar);
  if (key === null || ops === null) throw new Error('cozucu fonksiyonda key/ops bulunamadi');

  var hMul = 31, hMod = 251;
  if ((m = jsBody.match(/=\s*\([^;\r\n]*\*\s*(\d+)\s*\+\s*[a-zA-Z_$][\w$]*\s*\)\s*%\s*(\d+)\s*;/))) { hMul = +m[1]; hMod = +m[2]; }
  var hA = 0, hB = 0;
  for (var i = 0; i < key.length; i++) {
    var c = key.charCodeAt(i);
    hA = (hA * hMul + c) % hMod;
    hB = (hB ^ (c + i)) & 255;
  }
  var accStart = (hA + hB) % 256, accStep = (hA % 13) + 3;

  var sMod = 65521, sAdd = 1;
  if ((m = jsBody.match(/=\s*\(\([^;\r\n]*\*\s*256\s*\+\s*[^;\r\n]*\)\s*%\s*(\d+)\s*\)\s*\+\s*(\d+)\s*;/))) { sMod = +m[1]; sAdd = +m[2]; }
  var state = ((hA * 256 + hB) % sMod) + sAdd;

  for (var p = ops.length - 1; p >= 0; p--) {
    var op = ops.charAt(p);
    if (op === 'b') value = b64decodeBinary(value);
    else if (op === 'v') value = value.split('').reverse().join('');
    else {
      var sh = (26 - ((op.charCodeAt(0) - 64) % 26)) % 26;
      if (sh < 0) sh += 26;
      value = rot(value, sh);
    }
  }

  var mul = 75, add = 74, mod = 65537;
  if ((m = jsBody.match(/([a-zA-Z_$][\w$]*)\s*=\s*\(\1\s*\*\s*(\d+)\s*\+\s*(\d+)\s*\)\s*%\s*(\d+)\s*;/))) { mul = +m[2]; add = +m[3]; mod = +m[4]; }
  var len = value.length, sw = [];
  for (var q = len - 1; q >= 1; q--) {
    state = (state * mul + add) % mod;
    sw[q] = state % (q + 1);
  }
  var ch = value.split('');
  for (var z = 1; z < len; z++) {
    var j = sw[z] || 0, t = ch[z]; ch[z] = ch[j]; ch[j] = t;
  }

  var acc = accStart, out = '';
  for (var n = 0; n < ch.length; n++) {
    var b = ch[n].charCodeAt(0) & 255;
    acc = (acc + accStep) % 256;
    out += String.fromCharCode(b ^ acc);
    acc = (acc + b) % 256;
  }
  if (!out) throw new Error('bos sonuc');
  return utf8FromBinary(out).split('.txt').join('.m3u8');
}

function findFunctionBody(page, name) {
  var n = esc(name);
  var pats = [
    new RegExp('function\\s+' + n + '\\s*\\([^)]*\\)\\s*\\{'),
    new RegExp('(?:var|let|const)\\s+' + n + '\\s*=\\s*(?:async\\s*)?function\\s*[\\w$]*\\s*\\([^)]*\\)\\s*\\{'),
    new RegExp('(?:^|[^\\w$])' + n + '\\s*=\\s*(?:async\\s*)?\\(?[^)=]*\\)?\\s*=>\\s*\\{')
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = pats[i].exec(page);
    if (m) {
      var start = m.index + m[0].length;
      var end = matchClose(page, start - 1, '{', '}');
      if (end > 0) return page.slice(start, end);
    }
  }
  return null;
}

function arrayCalls(page, v) {
  var res = [];
  var re = new RegExp('(?:^|[^\\w$])' + esc(v) + '\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(\\s*\\[', 'g');
  var m;
  while ((m = re.exec(page))) {
    var open = m.index + m[0].length - 1;
    var end = matchClose(page, open, '[', ']');
    if (end > 0) {
      var lit = page.slice(open + 1, end), parts = [], r2 = /"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'/g, mm;
      while ((mm = r2.exec(lit))) parts.push(jsUnescape(mm[1] !== undefined ? mm[1] : mm[2]));
      if (parts.length) res.push({ fn: m[1], parts: parts });
    }
  }
  return res;
}

function decodePlayer(page) {
  var m = page.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*([a-zA-Z0-9_$]+)\s*,/i);
  if (!m) throw new Error('sources degiskeni bulunamadi');
  var calls = arrayCalls(page, m[1]), last = null;
  if (!calls.length) throw new Error("'" + m[1] + "' degiskeninin sifreli parca dizisi bulunamadi");
  for (var i = 0; i < calls.length; i++) {
    var body = findFunctionBody(page, calls[i].fn);
    if (body === null) { last = new Error("cozucu fonksiyon '" + calls[i].fn + "' bulunamadi"); continue; }
    try { return decodeParts(calls[i].parts, body); } catch (e) { last = e; }
  }
  throw last;
}

// ---------------------------------------------------------------- Film Makinesi akışı
function step(name, promise) {
  return promise.catch(function (e) {
    var msg = e && e.message ? e.message : String(e);
    throw new Error(name + ': ' + msg);
  });
}

function findStream(imdb) {
  var searchUrl = BASE + '/ajax/autocomplete/?s=' + encodeURIComponent(imdb);
  var filmUrl, dil;
  return step('1-arama', httpGet(searchUrl, searchUrl)).then(function (txt) {
    var data;
    try { data = JSON.parse(txt); } catch (e) { throw new Error('1-arama: JSON degil (' + txt.slice(0, 60).replace(/\s+/g, ' ') + ')'); }
    if (!data || !data.kayitlar) throw new Error('sonuc yok');
    var h = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/i.exec(data.kayitlar);
    if (!h) throw new Error('kayitlarda href yok');
    filmUrl = absolutize(h[1]);
    return step('2-film sayfasi', httpGet(filmUrl, filmUrl));
  }).then(function (filmHtml) {
    var low = filmHtml.toLowerCase();
    var dub = low.indexOf('türkçe dublaj') !== -1, sub = low.indexOf('altyazılı') !== -1;
    dil = dub && sub ? 'Dublaj & Altyazı' : dub ? 'Dublaj' : 'Altyazılı / Dublaj';
    var f = /<iframe[^>]+data-src=["']([^"']+)["']/i.exec(filmHtml);
    if (!f) throw new Error('iframe data-src bulunamadi');
    return step('3-player', httpGet(absolutize(f[1]), CLOSE));
  }).then(function (playerHtml) {
    var video;
    try { video = decodePlayer(playerHtml); } catch (e) { throw new Error('4-cozme: ' + e.message + ' [sayfa ' + playerHtml.length + ' karakter]'); }
    return {
      name: 'Film Makinesi',
      title: dil,
      url: video,
      quality: 'Auto',
      headers: { 'Referer': CLOSE + '/', 'Origin': CLOSE, 'User-Agent': UA }
    };
  });
}

function getImdbId(tmdbId) {
  var id = String(tmdbId);
  if (/^tt\d+$/.test(id)) return Promise.resolve(id);
  if (!TMDB_API_KEY || TMDB_API_KEY.indexOf('BURAYA') === 0) {
    return Promise.reject(new Error('TMDB_API_KEY ayarlanmamis'));
  }
  return fetch('https://api.themoviedb.org/3/movie/' + encodeURIComponent(id) + '/external_ids?api_key=' + TMDB_API_KEY)
    .then(function (r) { if (!r.ok) throw new Error('TMDB HTTP ' + r.status); return r.json(); })
    .then(function (j) {
      if (!j || !j.imdb_id) throw new Error('TMDB imdb_id yok');
      return j.imdb_id;
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (mediaType !== 'movie') return Promise.resolve([]);   // PHP'de de yalnızca film
  return step('0-TMDB', getImdbId(tmdbId))
    .then(findStream)
    .then(function (s) { return [s]; })
    .catch(function (e) {
      var msg = e && e.message ? e.message : String(e);
      console.error('[FilmMakinesi] ' + msg);
      if (!DEBUG) return [];
      return [{ name: 'Film Makinesi', title: 'HATA: ' + msg, url: 'https://example.com/hata.m3u8', quality: 'Auto' }];
    });
}

module.exports = { getStreams: getStreams, _decodePlayer: decodePlayer };
