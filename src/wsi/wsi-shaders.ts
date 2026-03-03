import { createProgram, requireUniformLocation } from "../core/gl-utils";
import type { PointProgram, TileVertexProgram } from "./wsi-renderer-types";

export function initTileProgram(gl: WebGL2RenderingContext): TileVertexProgram {
  const vertex = `#version 300 es
    precision highp float;
    in vec2 aUnit;
    in vec2 aUv;
    uniform mat3 uCamera;
    uniform vec4 uBounds;
    out vec2 vUv;
    void main() {
      vec2 world = vec2(
        mix(uBounds.x, uBounds.z, aUnit.x),
        mix(uBounds.y, uBounds.w, aUnit.y)
      );
      vec3 clip = uCamera * vec3(world, 1.0);
      gl_Position = vec4(clip.xy, 0.0, 1.0);
      vUv = aUv;
    }`;

  const fragment = `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform sampler2D uTexture;
    uniform float uBrightness;
    uniform float uContrast;
    uniform float uSaturation;
    out vec4 outColor;
    void main() {
      vec4 color = texture(uTexture, vUv);

      color.rgb = clamp(
        (uContrast + 1.0) * color.rgb - (uContrast / 2.0),
        vec3(0.0),
        vec3(1.0)
      );

      float saturation = uSaturation + 1.0;
      float sr = (1.0 - saturation) * 0.2126;
      float sg = (1.0 - saturation) * 0.7152;
      float sb = (1.0 - saturation) * 0.0722;
      mat3 saturationMatrix = mat3(
        sr + saturation, sr, sr,
        sg, sg + saturation, sg,
        sb, sb, sb + saturation
      );
      color.rgb = clamp(saturationMatrix * color.rgb, vec3(0.0), vec3(1.0));

      color.rgb = clamp(color.rgb + uBrightness, vec3(0.0), vec3(1.0));
      outColor = color;
    }`;

  const program = createProgram(gl, vertex, fragment);
  const uCamera = requireUniformLocation(gl, program, "uCamera");
  const uBounds = requireUniformLocation(gl, program, "uBounds");
  const uTexture = requireUniformLocation(gl, program, "uTexture");
  const uBrightness = requireUniformLocation(gl, program, "uBrightness");
  const uContrast = requireUniformLocation(gl, program, "uContrast");
  const uSaturation = requireUniformLocation(gl, program, "uSaturation");

  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) {
    throw new Error("buffer allocation failed");
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]), gl.STATIC_DRAW);

  const aUnit = gl.getAttribLocation(program, "aUnit");
  const aUv = gl.getAttribLocation(program, "aUv");
  if (aUnit < 0 || aUv < 0) {
    throw new Error("tile attribute lookup failed");
  }
  gl.enableVertexAttribArray(aUnit);
  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(aUnit, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return {
    program,
    vao,
    vbo,
    uCamera,
    uBounds,
    uTexture,
    uBrightness,
    uContrast,
    uSaturation,
  };
}

export function initPointProgram(gl: WebGL2RenderingContext): PointProgram {
  const pointVertex = `#version 300 es
    precision highp float;
    in vec2 aPosition;
    in uint aTerm;
    in uint aFillMode;
    uniform mat3 uCamera;
    uniform float uPointSize;
    flat out uint vTerm;
    flat out uint vFillMode;
    void main() {
      vec3 clip = uCamera * vec3(aPosition, 1.0);
      gl_Position = vec4(clip.xy, 0.0, 1.0);
      gl_PointSize = uPointSize;
      vTerm = aTerm;
      vFillMode = aFillMode;
    }`;

  const pointFragment = `#version 300 es
    precision highp float;
    flat in uint vTerm;
    flat in uint vFillMode;
    uniform sampler2D uPalette;
    uniform float uPaletteSize;
    uniform float uPointSize;
    uniform float uPointStrokeScale;
    out vec4 outColor;
    void main() {
      vec2 pc = gl_PointCoord * 2.0 - 1.0;
      float r = length(pc);
      if (r > 1.0) discard;

      float idx = clamp(float(vTerm), 0.0, max(0.0, uPaletteSize - 1.0));
      vec2 uv = vec2((idx + 0.5) / uPaletteSize, 0.5);
      vec4 color = texture(uPalette, uv);
      if (color.a <= 0.0) discard;

      float aa = 1.5 / max(1.0, uPointSize);
      float outerMask = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
      float alpha = 0.0;
      if (vFillMode != 0u) {
        alpha = outerMask * color.a;
      } else {
        float s = uPointStrokeScale;
        float ringWidth = clamp(3.0 * s / max(1.0, uPointSize), 0.12 * s, 0.62 * s);
        float innerRadius = 1.0 - ringWidth;
        float innerMask = smoothstep(innerRadius - aa, innerRadius + aa, r);
        alpha = outerMask * innerMask * color.a;
      }
      if (alpha <= 0.001) discard;

      outColor = vec4(color.rgb * alpha, alpha);
    }`;

  const program = createProgram(gl, pointVertex, pointFragment);
  const uCamera = requireUniformLocation(gl, program, "uCamera");
  const uPointSize = requireUniformLocation(gl, program, "uPointSize");
  const uPointStrokeScale = requireUniformLocation(gl, program, "uPointStrokeScale");
  const uPalette = requireUniformLocation(gl, program, "uPalette");
  const uPaletteSize = requireUniformLocation(gl, program, "uPaletteSize");

  const vao = gl.createVertexArray();
  const posBuffer = gl.createBuffer();
  const termBuffer = gl.createBuffer();
  const fillModeBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  const paletteTexture = gl.createTexture();
  if (!vao || !posBuffer || !termBuffer || !fillModeBuffer || !indexBuffer || !paletteTexture) {
    throw new Error("point buffer allocation failed");
  }

  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "aPosition");
  if (posLoc < 0) {
    throw new Error("point position attribute not found");
  }
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, termBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
  const termLoc = gl.getAttribLocation(program, "aTerm");
  if (termLoc < 0) {
    throw new Error("point term attribute not found");
  }
  gl.enableVertexAttribArray(termLoc);
  gl.vertexAttribIPointer(termLoc, 1, gl.UNSIGNED_SHORT, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, fillModeBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
  const fillModeLoc = gl.getAttribLocation(program, "aFillMode");
  if (fillModeLoc < 0) {
    throw new Error("point fill mode attribute not found");
  }
  gl.enableVertexAttribArray(fillModeLoc);
  gl.vertexAttribIPointer(fillModeLoc, 1, gl.UNSIGNED_BYTE, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

  gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([160, 160, 160, 255]));
  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    program,
    vao,
    posBuffer,
    termBuffer,
    fillModeBuffer,
    indexBuffer,
    paletteTexture,
    uCamera,
    uPointSize,
    uPointStrokeScale,
    uPalette,
    uPaletteSize,
  };
}
