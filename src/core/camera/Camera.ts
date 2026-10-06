// Front-camera lifecycle: permission handling, resolution negotiation,
// disconnection detection, and reliable start/stop. Framework-agnostic — the
// pipeline/UI drive it; it knows nothing about React.

export type CameraErrorKind =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'not-found'
  | 'in-use'
  | 'overconstrained'
  | 'disconnected'
  | 'unknown';

export class CameraError extends Error {
  readonly kind: CameraErrorKind;
  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.name = 'CameraError';
    this.kind = kind;
  }
}

const FRIENDLY: Record<CameraErrorKind, string> = {
  'insecure-context':
    'Camera access needs a secure context. Use https:// or localhost.',
  unsupported: 'This browser does not support camera capture (getUserMedia).',
  'permission-denied':
    'Camera permission was denied. Allow access in your browser settings and retry.',
  'not-found': 'No camera device was found.',
  'in-use': 'The camera is already in use by another app or tab.',
  overconstrained: 'The requested camera settings are not supported by this device.',
  disconnected: 'The camera was disconnected.',
  unknown: 'Could not start the camera.',
};

export interface CameraOptions {
  width?: number;
  height?: number;
  facingMode?: 'user' | 'environment';
  /** Called if the camera track ends unexpectedly (unplugged, revoked). */
  onDisconnect?: (error: CameraError) => void;
}

function classify(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  const name = (err as DOMException)?.name ?? '';
  let kind: CameraErrorKind = 'unknown';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      kind = 'permission-denied';
      break;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      kind = 'not-found';
      break;
    case 'NotReadableError':
    case 'TrackStartError':
      kind = 'in-use';
      break;
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      kind = 'overconstrained';
      break;
  }
  return new CameraError(kind, FRIENDLY[kind]);
}

export class Camera {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private starting: Promise<void> | null = null;
  private onDisconnect?: (error: CameraError) => void;

  constructor(video?: HTMLVideoElement) {
    this.video = video ?? document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    // Hint the decoder; the element itself is never shown (we draw to canvas).
    this.video.setAttribute('playsinline', '');
  }

  get isActive(): boolean {
    return this.stream !== null && this.stream.active;
  }

  get dimensions(): { width: number; height: number } {
    return {
      width: this.video.videoWidth || 0,
      height: this.video.videoHeight || 0,
    };
  }

  async start(opts: CameraOptions = {}): Promise<void> {
    if (this.isActive) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart(opts).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(opts: CameraOptions): Promise<void> {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw new CameraError('insecure-context', FRIENDLY['insecure-context']);
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('unsupported', FRIENDLY.unsupported);
    }

    this.onDisconnect = opts.onDisconnect;
    const facingMode = opts.facingMode ?? 'user';
    const width = opts.width ?? 1280;
    const height = opts.height ?? 720;

    const ideal: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode,
        width: { ideal: width },
        height: { ideal: height },
      },
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(ideal);
    } catch (err) {
      const e = classify(err);
      // Fall back to a looser constraint set if the resolution was rejected.
      if (e.kind === 'overconstrained') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode },
          });
        } catch (err2) {
          throw classify(err2);
        }
      } else {
        throw e;
      }
    }

    this.stream = stream;
    this.attachDisconnectWatch(stream);
    this.video.srcObject = stream;

    await this.waitForReady();
  }

  private attachDisconnectWatch(stream: MediaStream): void {
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        // Only react to the live stream ending (ignore our own stop()).
        if (this.stream === stream) {
          const err = new CameraError('disconnected', FRIENDLY.disconnected);
          this.cleanup();
          this.onDisconnect?.(err);
        }
      });
    }
  }

  private async waitForReady(): Promise<void> {
    const video = this.video;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      await this.safePlay();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new CameraError('unknown', 'Timed out waiting for the camera to start.'));
      }, 10_000);
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new CameraError('unknown', FRIENDLY.unknown));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
    await this.safePlay();
  }

  private async safePlay(): Promise<void> {
    try {
      await this.video.play();
    } catch {
      // Autoplay can reject if not user-initiated; the stream is still live and
      // drawable to canvas, so this is non-fatal.
    }
  }

  stop(): void {
    this.cleanup();
  }

  private cleanup(): void {
    const stream = this.stream;
    this.stream = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (this.video.srcObject) {
      this.video.srcObject = null;
    }
  }
}
