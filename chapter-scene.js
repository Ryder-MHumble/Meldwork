/* Exact PixelBlast fragment shader and motion parameters from
 * frontend/src/components/PixelBlast.vue (React Bits / David Haz).
 * assets/react-bits-LICENSE.md. Rendered directly with WebGL2 for the static page.
 */
(function () {
  "use strict";
  var canvas = document.getElementById("chapterCanvas");
  var scene = document.querySelector(".chapter-scene");
  var toggle = document.getElementById("chapterMotionToggle");
  var hero = document.querySelector(".hero");
  var gl = canvas.getContext("webgl2", {
    alpha: true, antialias: false, premultipliedAlpha: false,
    powerPreference: "high-performance", preserveDrawingBuffer: true
  });
  if (!gl) { toggle.hidden = true; return; }

  var FRAGMENT_SHADER = `
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uPixelSize;
uniform float uScale;
uniform float uDensity;
uniform float uPixelJitter;
uniform float uEdgeFade;
uniform float uOpacity;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uTertiaryColor;

out vec4 fragColor;

float Bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}

#define Bayer4(a) (Bayer2(0.5 * (a)) * 0.25 + Bayer2(a))
#define Bayer8(a) (Bayer4(0.5 * (a)) * 0.25 + Bayer2(a))

float hash11(float n) {
  return fract(sin(n) * 43758.5453);
}

float vnoise(vec3 p) {
  vec3 ip = floor(p);
  vec3 fp = fract(p);
  float n000 = hash11(dot(ip + vec3(0.0, 0.0, 0.0), vec3(1.0, 57.0, 113.0)));
  float n100 = hash11(dot(ip + vec3(1.0, 0.0, 0.0), vec3(1.0, 57.0, 113.0)));
  float n010 = hash11(dot(ip + vec3(0.0, 1.0, 0.0), vec3(1.0, 57.0, 113.0)));
  float n110 = hash11(dot(ip + vec3(1.0, 1.0, 0.0), vec3(1.0, 57.0, 113.0)));
  float n001 = hash11(dot(ip + vec3(0.0, 0.0, 1.0), vec3(1.0, 57.0, 113.0)));
  float n101 = hash11(dot(ip + vec3(1.0, 0.0, 1.0), vec3(1.0, 57.0, 113.0)));
  float n011 = hash11(dot(ip + vec3(0.0, 1.0, 1.0), vec3(1.0, 57.0, 113.0)));
  float n111 = hash11(dot(ip + vec3(1.0, 1.0, 1.0), vec3(1.0, 57.0, 113.0)));
  vec3 weight = fp * fp * fp * (fp * (fp * 6.0 - 15.0) + 10.0);
  float x00 = mix(n000, n100, weight.x);
  float x10 = mix(n010, n110, weight.x);
  float x01 = mix(n001, n101, weight.x);
  float x11 = mix(n011, n111, weight.x);
  return mix(mix(x00, x10, weight.y), mix(x01, x11, weight.y), weight.z) * 2.0 - 1.0;
}

float fbm(vec2 uv, float time) {
  vec3 point = vec3(uv * uScale, time);
  float amplitude = 1.0;
  float frequency = 1.0;
  float sum = 1.0;
  for (int index = 0; index < 5; ++index) {
    sum += amplitude * vnoise(point * frequency);
    frequency *= 1.25;
  }
  return sum * 0.5 + 0.5;
}

void main() {
  vec2 fragCoord = gl_FragCoord.xy - uResolution * 0.5;
  float aspectRatio = uResolution.x / uResolution.y;
  vec2 pixelId = floor(fragCoord / uPixelSize);
  vec2 pixelUv = fract(fragCoord / uPixelSize);
  float cellPixelSize = 8.0 * uPixelSize;
  vec2 cellCoord = floor(fragCoord / cellPixelSize) * cellPixelSize;
  vec2 fieldUv = cellCoord / uResolution * vec2(aspectRatio, 1.0);

  float motionTime = uTime * (1.0 + 0.12 * sin(uTime * 0.17));
  vec2 drift = vec2(sin(uTime * 0.41), cos(uTime * 0.33)) * 0.045;
  float field = fbm(fieldUv + drift, motionTime * 0.05) * 0.5 - 0.65;
  float feed = field + (uDensity - 0.5) * 0.3;
  float bayer = Bayer8(fragCoord / uPixelSize) - 0.5;
  float enabled = step(0.5, feed + bayer);
  float hash = fract(sin(dot(pixelId, vec2(127.1, 311.7))) * 43758.5453);
  float jitter = 1.0 + (hash - 0.5) * uPixelJitter;
  float inset = step(0.08, pixelUv.x) * step(0.08, pixelUv.y)
    * step(pixelUv.x, 0.92) * step(pixelUv.y, 0.92);
  float mask = enabled * jitter * inset;

  vec2 normalized = gl_FragCoord.xy / uResolution;
  float edge = min(min(normalized.x, normalized.y), min(1.0 - normalized.x, 1.0 - normalized.y));
  mask *= smoothstep(0.0, uEdgeFade, edge);
  float centerDistance = length((normalized - 0.5) * vec2(aspectRatio, 1.0));
  // Keep the message area visually calm while preserving the animated field
  // around the edges of the discovery screen.
  mask *= mix(0.1, 1.0, smoothstep(0.14, 0.46, centerDistance));

  float colorNoise = clamp(0.5 + 0.5 * vnoise(vec3((fieldUv + drift * 1.8) * 1.35, motionTime * 0.035)), 0.0, 1.0);
  vec3 color = mix(uPrimaryColor, uSecondaryColor, colorNoise);
  color = mix(color, uTertiaryColor, smoothstep(0.56, 1.0, normalized.y + colorNoise * 0.18));
  fragColor = vec4(color, mask * uOpacity);
}
`;
  var VERTEX_SHADER = `
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;
  var program;
  var uniforms = {};
  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var paused = false, visible = false, lost = false;
  var frame = 0, previousFrame = 0;
  var time = Math.random() * 1000;

  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, "#version 300 es\n" + source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(error);
    }
    return shader;
  }

  function initialize() {
    var vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    var fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    ["uResolution", "uTime", "uPixelSize", "uScale", "uDensity", "uPixelJitter",
      "uEdgeFade", "uOpacity", "uPrimaryColor", "uSecondaryColor", "uTertiaryColor"].forEach(function (name) {
      uniforms[name] = gl.getUniformLocation(program, name);
    });
    gl.uniform1f(uniforms.uScale, 2.2);
    gl.uniform1f(uniforms.uDensity, 1.26);
    gl.uniform1f(uniforms.uPixelJitter, 0.32);
    gl.uniform1f(uniforms.uEdgeFade, 0.12);
    gl.uniform1f(uniforms.uOpacity, 0.42);
    canvas.dataset.renderer = "webgl2";
  }

  // Match THREE.Color's sRGB-to-linear conversion for the desktop theme colors.
  function color(name, hex) {
    var rgb = hex.match(/[a-f0-9]{2}/gi).map(function (channel) {
      var value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    gl.uniform3fv(uniforms[name], rgb);
  }
  function updateTheme() {
    if (lost) return;
    var light = document.documentElement.getAttribute("data-theme") === "light";
    color("uPrimaryColor", light ? "#d92f24" : "#ff836d");
    color("uSecondaryColor", light ? "#007d91" : "#54f5ff");
    color("uTertiaryColor", light ? "#ed512f" : "#ffa36f");
    paint();
  }
  function paint() {
    if (lost) return;
    gl.uniform1f(uniforms.uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function updateButton() {
    toggle.hidden = !visible || motion.matches || lost;
    toggle.setAttribute("aria-pressed", String(paused));
    var label = paused ? "Resume background animation" : "Pause background animation";
    label = window.MeldworkLocale ? window.MeldworkLocale.t(label) : label;
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }
  function running() { return visible && !paused && !motion.matches && !document.hidden && !lost; }
  function tick(now) {
    frame = 0;
    if (!running()) return;
    if (previousFrame) time += Math.min(32, now - previousFrame) * 0.00036;
    previousFrame = now;
    paint();
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    var entrance = Math.max(0, Math.min(1, (window.scrollY - hero.offsetHeight * 0.55) / (window.innerHeight * 0.45)));
    visible = entrance > 0;
    scene.style.opacity = entrance.toFixed(3);
    updateButton();
    if (running()) {
      if (!frame) frame = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(frame);
      frame = 0;
      previousFrame = 0;
    }
  }
  function resize() {
    if (lost) return;
    var ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.uResolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.uPixelSize, 3.7 * ratio);
    paint();
    sync();
  }

  try { initialize(); } catch (error) {
    toggle.hidden = true;
    console.error("PixelBlast initialization failed:", error);
    return;
  }
  toggle.addEventListener("click", function () { paused = !paused; sync(); });
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", sync);
  motion.addEventListener("change", sync);
  window.addEventListener("meldwork:languagechange", updateButton);
  new ResizeObserver(sync).observe(hero);
  new MutationObserver(updateTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  canvas.addEventListener("webglcontextlost", function (event) {
    event.preventDefault();
    lost = true;
    sync();
  });
  canvas.addEventListener("webglcontextrestored", function () {
    lost = false;
    initialize();
    updateTheme();
    resize();
  });
  updateTheme();
  resize();
})();
