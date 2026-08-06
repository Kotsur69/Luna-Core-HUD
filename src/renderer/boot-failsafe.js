// Boot overlay failsafe. Deliberately a CLASSIC script loaded before renderer.js:
// if the renderer dies while parsing (the `t` collision with i18n.js once did
// exactly that), nothing would ever take the overlay down and it would cover the
// whole HUD permanently. A classic script does not sit in the module graph, so
// this timer survives that failure - which is the entire point of it.
//
// D4: this used to be inline in index.html. It moved out so the
// Content-Security-Policy can keep `script-src 'self'` instead of granting
// 'unsafe-inline'. An external classic script is just as immune to a module
// parse error, so the guarantee above is unchanged.
setTimeout(function () {
  var b = document.getElementById('boot');
  if (b && !b.hidden) b.hidden = true;
}, 4000);
