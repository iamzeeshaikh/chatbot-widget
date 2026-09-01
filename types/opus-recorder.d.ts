// opus-recorder ships no types. Only the handful of members this app uses are
// declared — a fuller guess would be less honest, not more useful.
declare module 'opus-recorder' {
  interface RecorderOptions {
    encoderPath?: string
    numberOfChannels?: number
    encoderSampleRate?: number
    /** libopus application: 2048 = VOIP, tuned for speech. */
    encoderApplication?: number
    streamPages?: boolean
  }
  export default class Recorder {
    constructor(options?: RecorderOptions)
    ondataavailable: (data: Uint8Array) => void
    start(): Promise<void>
    stop(): void
  }
}
