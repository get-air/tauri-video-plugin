import { Channel, invoke } from '@tauri-apps/api/core'

const COMMAND = 'plugin:video|'

export class WindowsFrameRenderer {
  readonly #canvas: HTMLCanvasElement
  readonly #gl: WebGLRenderingContext
  readonly #texture: WebGLTexture
  readonly #channel = new Channel<Uint8Array>()
  readonly #anchor: HTMLVideoElement
  readonly #fixed: boolean
  #destroyed = false

  constructor(anchor: HTMLVideoElement, fixed: boolean) {
    const canvas = document.createElement('canvas')
    if (!fixed) canvas.slot = 'media'
    canvas.className = 'tauri-video-frame-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    Object.assign(canvas.style, {
      position: fixed ? 'fixed' : 'absolute',
      inset: fixed ? '' : '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      pointerEvents: 'none',
      background: '#000',
    })
    anchor.insertAdjacentElement('afterend', canvas)
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      desynchronized: true,
      preserveDrawingBuffer: false,
      stencil: false,
    })
    if (!gl) {
      canvas.remove()
      throw new Error('WebGL is unavailable for Windows native video frames')
    }
    const program = createProgram(gl)
    gl.useProgram(program)
    const vertices = new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      -1, 1, 0, 0,
      1, -1, 1, 1,
      1, 1, 1, 0,
    ])
    const buffer = gl.createBuffer()
    if (!buffer) throw new Error('WebGL could not allocate the video vertex buffer')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    const textureCoordinate = gl.getAttribLocation(program, 'textureCoordinate')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(textureCoordinate)
    gl.vertexAttribPointer(textureCoordinate, 2, gl.FLOAT, false, 16, 8)
    const texture = gl.createTexture()
    if (!texture) throw new Error('WebGL could not allocate the video texture')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    this.#canvas = canvas
    this.#gl = gl
    this.#texture = texture
    this.#anchor = anchor
    this.#fixed = fixed
    this.syncLayout()
  }

  async start(sessionKey: string): Promise<void> {
    this.#channel.onmessage = (frame) => this.#render(frame)
    await invoke(`${COMMAND}native_frame_stream`, {
      sessionKey,
      onFrame: this.#channel,
    })
  }

  setFit(mode: 'contain' | 'cover' | 'fill'): void {
    this.#canvas.style.objectFit = mode
  }

  setZoom(scale: number): void {
    this.#canvas.style.transform = scale === 1 ? '' : `scale(${scale})`
    this.#canvas.style.transformOrigin = 'center'
  }

  syncLayout(): void {
    if (!this.#fixed) return
    const rect = this.#anchor.getBoundingClientRect()
    this.#canvas.style.left = `${rect.left}px`
    this.#canvas.style.top = `${rect.top}px`
    this.#canvas.style.width = `${rect.width}px`
    this.#canvas.style.height = `${rect.height}px`
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#channel.onmessage = () => undefined
    this.#canvas.remove()
  }

  #render(value: Uint8Array | ArrayBuffer | number[]): void {
    if (this.#destroyed) return
    const frame = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value)
    if (frame.byteLength < 8) return
    const header = new DataView(frame.buffer, frame.byteOffset, 8)
    const width = header.getUint32(0, true)
    const height = header.getUint32(4, true)
    const expected = width * height * 4
    if (width === 0 || height === 0 || frame.byteLength - 8 !== expected) return
    const gl = this.#gl
    const resized = this.#canvas.width !== width || this.#canvas.height !== height
    if (resized) {
      this.#canvas.width = width
      this.#canvas.height = height
      gl.viewport(0, 0, width, height)
    }
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    const pixels = frame.subarray(8)
    if (resized) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      )
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      )
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec2 position;
    attribute vec2 textureCoordinate;
    varying vec2 videoCoordinate;
    void main() {
      videoCoordinate = textureCoordinate;
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform sampler2D videoTexture;
    varying vec2 videoCoordinate;
    void main() {
      gl_FragColor = texture2D(videoTexture, videoCoordinate);
    }
  `)
  const program = gl.createProgram()
  if (!program) throw new Error('WebGL could not allocate the video program')
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'WebGL could not link the video program')
  }
  return program
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('WebGL could not allocate a video shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'WebGL could not compile a video shader')
  }
  return shader
}
