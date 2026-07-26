// iOS Shortcut — "Run JavaScript on Web Page"
// Paste seluruh kode ini ke action "Run JavaScript on Web Page"

var s = "https://aasjdhov.my.id";
var k = "hanz-osaidhsf-woiiahds";

if (!window.__diceCtrlLoaded) {
  window.__diceCtrlLoaded = true;

  var st = { on: true, v: [], i: 0, r: false };
  var rt = null;

  // Deteksi klik tombol Lempar/Roll
  document.addEventListener("click", function(e) {
    var el = e.target;
    for (var j = 0; j < 10 && el && el !== document; j++) {
      var a = (el.getAttribute("aria-label") || "").toLowerCase();
      var t = (el.textContent || "").trim().toLowerCase();
      if (a === "lempar" || a === "roll" || t === "lempar" || t === "roll") {
        st.i = 0;
        st.r = true;
        clearTimeout(rt);
        rt = setTimeout(function() { st.r = false; }, 3000);
        break;
      }
      el = el.parentNode;
    }
  }, true);

  // Override Math.random
  var _r = Math.random;
  Math.random = function() {
    if (!st.on || st.v.length === 0 || !st.r) return _r();
    var i = st.i % st.v.length;
    var v = Math.max(1, Math.min(st.v[i], 6));
    st.i++;
    return (v - 0.5) / 6;
  };

  // Override crypto.getRandomValues
  if (window.crypto && window.crypto.getRandomValues) {
    var _c = window.crypto.getRandomValues.bind(window.crypto);
    window.crypto.getRandomValues = function(a) {
      if (!st.on || st.v.length === 0 || !st.r) return _c(a);
      for (var i = 0; i < a.length; i++) {
        var vi = st.i % st.v.length;
        var v = Math.max(1, Math.min(st.v[vi], 6));
        st.i++;
        var n = (v - 0.5) / 6;
        if (a instanceof Uint32Array) a[i] = (n * 4294967296) | 0;
        else if (a instanceof Uint16Array) a[i] = (n * 65536) | 0;
        else a[i] = (n * 256) | 0;
      }
      return a;
    };
  }

  // Callback untuk JSONP
  window.__dc = function(d) {
    if (!d) return;
    if (d.overrideEnabled !== undefined) st.on = d.overrideEnabled;
    if (d.distribution && Array.isArray(d.distribution)) {
      st.v = d.distribution.slice();
    }
  };

  // Polling via JSONP (paling reliable lewat CSP)
  function poll() {
    var o = document.getElementById("__djs");
    if (o) o.remove();
    var sc = document.createElement("script");
    sc.id = "__djs";
    sc.src = s + "/api/jsonp?key=" + encodeURIComponent(k) + "&callback=__dc&_t=" + Date.now();
    sc.onerror = function() {
      this.remove();
      // Fallback ke fetch
      fetch(s + "/api/total?_t=" + Date.now(), {
        headers: { "X-API-Key": k }, mode: "cors"
      }).then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) { if (d) window.__dc(d); })
        .catch(function() {});
    };
    sc.onload = function() { this.remove(); };
    (document.head || document.documentElement).appendChild(sc);
  }

  poll();
  setInterval(poll, 500);
  window.__diceCtrl = st;
}

// WAJIB: panggil completion() agar Shortcut selesai
completion(true);
