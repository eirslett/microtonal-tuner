class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunk = new Float32Array(512)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    let offset = 0
    while (offset < channel.length) {
      const space = this.chunk.length - this.filled
      const count = Math.min(space, channel.length - offset)
      this.chunk.set(channel.subarray(offset, offset + count), this.filled)
      this.filled += count
      offset += count
      if (this.filled === this.chunk.length) {
        this.port.postMessage(this.chunk)
        this.chunk = new Float32Array(this.chunk.length)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('mic-capture', MicCaptureProcessor)
