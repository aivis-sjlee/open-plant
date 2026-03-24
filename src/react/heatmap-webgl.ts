import { createProgram } from "../core/gl-utils";

const ACCUM_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 aCenter;
in float aWeight;
uniform vec2 uResolution;
uniform float uPointSize;
out float vWeight;
void main() {
  vec2 zeroToOne = aCenter / uResolution;
  vec2 clip = vec2(zeroToOne.x * 2.0 - 1.0, 1.0 - zeroToOne.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = uPointSize;
  vWeight = aWeight;
}`;

const ACCUM_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in float vWeight;
uniform float uCoreRatio;
uniform float uPointAlpha;
out vec4 outColor;
void main() {
  vec2 pointCoord = gl_PointCoord * 2.0 - 1.0;
  float radius = length(pointCoord);
  if (radius > 1.0) discard;

  float coreRatio = clamp(uCoreRatio, 0.02, 0.98);
  float intensity = 1.0 - smoothstep(coreRatio, 1.0, radius);
  float alpha = intensity * max(0.0, vWeight) * max(0.0, uPointAlpha);
  if (alpha <= 0.0001) discard;
  outColor = vec4(0.0, 0.0, 0.0, alpha);
}`;

const COLOR_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const COLOR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uAccumTexture;
uniform sampler2D uGradientTexture;
uniform float uOpacity;
uniform float uCutoff;
uniform float uGain;
uniform float uGamma;
uniform float uBias;
uniform float uStretch;
uniform vec2 uResolution;
out vec4 outColor;
void main() {
  vec2 accumUv = vec2(
    (gl_FragCoord.x - 0.5) / max(1.0, uResolution.x),
    (gl_FragCoord.y - 0.5) / max(1.0, uResolution.y)
  );
  float density = texture(uAccumTexture, accumUv).a;
  if (density <= uCutoff) discard;

  float boosted = 1.0 - exp(-max(0.0, density - uCutoff) * uGain);
  float contrast = clamp(uGamma, 0.35, 6.0);
  float bias = clamp(uBias, 0.0, 0.92);
  float biased = max(0.0, boosted - bias);
  float stretched = pow(
    biased / max(1e-5, 1.0 - bias),
    1.0 / clamp(uStretch, 1.0, 4.0)
  );
  float normalized = pow(stretched, 1.0 / contrast);
  float shoulder = 1.0 - pow(max(0.0, 1.0 - normalized), 1.0 + max(0.0, contrast - 1.0));
  float shoulderBlend = clamp((contrast - 1.0) * 0.32, 0.0, 0.78);
  float gradientT = mix(normalized, shoulder, shoulderBlend);
  vec4 gradientColor = texture(uGradientTexture, vec2(gradientT, 0.5));
  float alpha = gradientColor.a * clamp(uOpacity, 0.0, 1.0);
  if (alpha <= 0.0001) discard;
  outColor = vec4(gradientColor.rgb * alpha, alpha);
}`;

export interface HeatmapWebGLRenderParams {
  width: number;
  height: number;
  positions: Float32Array;
  weights: Float32Array;
  count: number;
  kernelRadiusPx: number;
  blurRadiusPx: number;
  pointAlpha: number;
  gradient: readonly string[];
  opacity: number;
  cutoff?: number;
  gain?: number;
  gamma?: number;
  bias?: number;
  stretch?: number;
}

export class HeatmapWebGLRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly gl: WebGL2RenderingContext;

  private readonly accumProgram: WebGLProgram;

  private readonly colorProgram: WebGLProgram;

  private readonly accumVao: WebGLVertexArrayObject;

  private readonly colorVao: WebGLVertexArrayObject;

  private readonly pointBuffer: WebGLBuffer;

  private readonly quadBuffer: WebGLBuffer;

  private readonly accumTexture: WebGLTexture;

  private readonly gradientTexture: WebGLTexture;

  private readonly framebuffer: WebGLFramebuffer;

  private readonly accumInternalFormat: number;

  private readonly accumTextureFormat: number;

  private readonly accumTextureType: number;

  private readonly uAccumResolution: WebGLUniformLocation;

  private readonly uAccumPointSize: WebGLUniformLocation;

  private readonly uAccumCoreRatio: WebGLUniformLocation;

  private readonly uAccumPointAlpha: WebGLUniformLocation;

  private readonly uColorAccumTexture: WebGLUniformLocation;

  private readonly uColorGradientTexture: WebGLUniformLocation;

  private readonly uColorOpacity: WebGLUniformLocation;

  private readonly uColorCutoff: WebGLUniformLocation;

  private readonly uColorGain: WebGLUniformLocation;

  private readonly uColorResolution: WebGLUniformLocation;

  private readonly uColorGamma: WebGLUniformLocation;

  private readonly uColorBias: WebGLUniformLocation;

  private readonly uColorStretch: WebGLUniformLocation;

  private pointCapacity = 0;

  private interleavedCapacity = 0;

  private interleavedBuffer: Float32Array | null = null;

  private gradientKey = "";

  constructor() {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 is not available for heatmap rendering.");
    }
    this.gl = gl;

    const colorBufferFloat = gl.getExtension("EXT_color_buffer_float");
    const supportsFloatAccum = Boolean(colorBufferFloat);
    this.accumInternalFormat = supportsFloatAccum ? gl.RGBA16F : gl.RGBA8;
    this.accumTextureFormat = gl.RGBA;
    this.accumTextureType = supportsFloatAccum ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    this.accumProgram = createProgram(gl, ACCUM_VERTEX_SHADER, ACCUM_FRAGMENT_SHADER);
    this.colorProgram = createProgram(gl, COLOR_VERTEX_SHADER, COLOR_FRAGMENT_SHADER);

    const accumVao = gl.createVertexArray();
    const colorVao = gl.createVertexArray();
    const pointBuffer = gl.createBuffer();
    const quadBuffer = gl.createBuffer();
    const accumTexture = gl.createTexture();
    const gradientTexture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!accumVao || !colorVao || !pointBuffer || !quadBuffer || !accumTexture || !gradientTexture || !framebuffer) {
      throw new Error("Failed to allocate heatmap WebGL resources.");
    }
    this.accumVao = accumVao;
    this.colorVao = colorVao;
    this.pointBuffer = pointBuffer;
    this.quadBuffer = quadBuffer;
    this.accumTexture = accumTexture;
    this.gradientTexture = gradientTexture;
    this.framebuffer = framebuffer;

    const accumResolution = gl.getUniformLocation(this.accumProgram, "uResolution");
    const accumPointSize = gl.getUniformLocation(this.accumProgram, "uPointSize");
    const accumCoreRatio = gl.getUniformLocation(this.accumProgram, "uCoreRatio");
    const accumPointAlpha = gl.getUniformLocation(this.accumProgram, "uPointAlpha");
    const colorAccumTexture = gl.getUniformLocation(this.colorProgram, "uAccumTexture");
    const colorGradientTexture = gl.getUniformLocation(this.colorProgram, "uGradientTexture");
    const colorOpacity = gl.getUniformLocation(this.colorProgram, "uOpacity");
    const colorCutoff = gl.getUniformLocation(this.colorProgram, "uCutoff");
    const colorGain = gl.getUniformLocation(this.colorProgram, "uGain");
    const colorGamma = gl.getUniformLocation(this.colorProgram, "uGamma");
    const colorBias = gl.getUniformLocation(this.colorProgram, "uBias");
    const colorStretch = gl.getUniformLocation(this.colorProgram, "uStretch");
    const colorResolution = gl.getUniformLocation(this.colorProgram, "uResolution");
    if (!accumResolution || !accumPointSize || !accumCoreRatio || !accumPointAlpha || !colorAccumTexture || !colorGradientTexture || !colorOpacity || !colorCutoff || !colorGain || !colorGamma || !colorBias || !colorStretch || !colorResolution) {
      throw new Error("Failed to resolve heatmap WebGL uniforms.");
    }
    this.uAccumResolution = accumResolution;
    this.uAccumPointSize = accumPointSize;
    this.uAccumCoreRatio = accumCoreRatio;
    this.uAccumPointAlpha = accumPointAlpha;
    this.uColorAccumTexture = colorAccumTexture;
    this.uColorGradientTexture = colorGradientTexture;
    this.uColorOpacity = colorOpacity;
    this.uColorCutoff = colorCutoff;
    this.uColorGain = colorGain;
    this.uColorGamma = colorGamma;
    this.uColorBias = colorBias;
    this.uColorStretch = colorStretch;
    this.uColorResolution = colorResolution;

    gl.bindVertexArray(this.accumVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);

    const centerLocation = gl.getAttribLocation(this.accumProgram, "aCenter");
    const weightLocation = gl.getAttribLocation(this.accumProgram, "aWeight");
    if (centerLocation < 0 || weightLocation < 0) {
      throw new Error("Failed to resolve heatmap WebGL attributes.");
    }
    gl.enableVertexAttribArray(centerLocation);
    gl.vertexAttribPointer(centerLocation, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(weightLocation);
    gl.vertexAttribPointer(weightLocation, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);

    gl.bindVertexArray(this.colorVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      1, 1,
    ]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(this.colorProgram, "aPosition");
    if (positionLocation < 0) {
      throw new Error("Failed to resolve heatmap color position attribute.");
    }
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindTexture(gl.TEXTURE_2D, this.gradientTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.ensureCanvasSize(1, 1);
  }

  render(params: HeatmapWebGLRenderParams): boolean {
    if (params.count <= 0 || params.width <= 0 || params.height <= 0) {
      return false;
    }

    this.ensureCanvasSize(params.width, params.height);
    this.ensureGradientTexture(params.gradient);
    this.uploadPointData(params.positions, params.weights, params.count);

    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, params.width, params.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.accumProgram);
    gl.bindVertexArray(this.accumVao);
    gl.uniform2f(this.uAccumResolution, params.width, params.height);
    gl.uniform1f(this.uAccumPointSize, Math.max(1, (params.kernelRadiusPx + params.blurRadiusPx) * 2));
    gl.uniform1f(this.uAccumCoreRatio, params.kernelRadiusPx / Math.max(1e-6, params.kernelRadiusPx + params.blurRadiusPx));
    gl.uniform1f(this.uAccumPointAlpha, Math.max(0, params.pointAlpha));
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, params.count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, params.width, params.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.colorProgram);
    gl.bindVertexArray(this.colorVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    gl.uniform1i(this.uColorAccumTexture, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gradientTexture);
    gl.uniform1i(this.uColorGradientTexture, 1);
    gl.uniform1f(this.uColorOpacity, params.opacity);
    gl.uniform1f(this.uColorCutoff, params.cutoff ?? 0.008);
    gl.uniform1f(this.uColorGain, params.gain ?? 2.6);
    gl.uniform1f(this.uColorGamma, params.gamma ?? 1.0);
    gl.uniform1f(this.uColorBias, params.bias ?? 0);
    gl.uniform1f(this.uColorStretch, params.stretch ?? 1);
    gl.uniform2f(this.uColorResolution, params.width, params.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.flush();

    return true;
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteTexture(this.accumTexture);
    gl.deleteTexture(this.gradientTexture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteBuffer(this.pointBuffer);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteVertexArray(this.accumVao);
    gl.deleteVertexArray(this.colorVao);
    gl.deleteProgram(this.accumProgram);
    gl.deleteProgram(this.colorProgram);
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  private ensureCanvasSize(width: number, height: number): void {
    const safeWidth = Math.max(1, Math.round(width));
    const safeHeight = Math.max(1, Math.round(height));
    if (this.canvas.width !== safeWidth) {
      this.canvas.width = safeWidth;
    }
    if (this.canvas.height !== safeHeight) {
      this.canvas.height = safeHeight;
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.accumInternalFormat,
      safeWidth,
      safeHeight,
      0,
      this.accumTextureFormat,
      this.accumTextureType,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accumTexture, 0);
    const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Heatmap framebuffer incomplete: ${framebufferStatus}`);
    }
  }

  private ensureGradientTexture(colors: readonly string[]): void {
    const nextKey = colors.join("|");
    if (this.gradientKey === nextKey) return;

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to create heatmap gradient canvas.");
    }

    const gradient = ctx.createLinearGradient(0, 0, 256, 0);
    const stops = colors.length > 1 ? colors : ["#00000000", "#3876FF", "#4CDDDD", "#FFE75C", "#FF8434", "#FF3434"];
    const step = 1 / Math.max(1, stops.length - 1);
    for (let index = 0; index < stops.length; index += 1) {
      gradient.addColorStop(index * step, stops[index]);
    }
    ctx.clearRect(0, 0, 256, 1);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 1);

    const pixels = ctx.getImageData(0, 0, 256, 1).data;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.gradientTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.gradientKey = nextKey;
  }

  private uploadPointData(positions: Float32Array, weights: Float32Array, count: number): void {
    const gl = this.gl;
    const requiredFloats = count * 3;
    const bytes = requiredFloats * 4;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    if (count > this.pointCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
      this.pointCapacity = count;
    }

    if (requiredFloats > this.interleavedCapacity) {
      this.interleavedCapacity = requiredFloats;
      this.interleavedBuffer = new Float32Array(requiredFloats);
    }
    const interleaved = this.interleavedBuffer;
    if (!interleaved) {
      throw new Error("Failed to allocate heatmap upload buffer.");
    }
    for (let index = 0; index < count; index += 1) {
      const sourceOffset = index * 2;
      const targetOffset = index * 3;
      interleaved[targetOffset] = positions[sourceOffset] ?? 0;
      interleaved[targetOffset + 1] = positions[sourceOffset + 1] ?? 0;
      interleaved[targetOffset + 2] = weights[index] ?? 0;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, interleaved.subarray(0, requiredFloats));
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
}
