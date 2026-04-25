/**
 * TypeScript declarations for guacamole-common-js 1.6.0.
 *
 * Strata vendors the upstream 1.6.0 source at `src/lib/guacamole-vendor.js`
 * (npm only publishes up to 1.5.0). The Vite alias in `vite.config.ts` and
 * `vitest.config.ts` redirects `import Guacamole from "guacamole-common-js"`
 * to the adapter module which re-exports `window.Guacamole`.
 *
 * These declarations describe the API surface used by Strata plus the
 * additions introduced in 1.6.0 (Display cursor, KeyEventInterpreter,
 * audio/video players, sync/audio/video client callbacks, Touch, etc).
 */
declare module "guacamole-common-js" {
  namespace Guacamole {
    // ────────────────────────────────────────────────────────────────
    // Status
    // ────────────────────────────────────────────────────────────────
    class Status {
      constructor(code: number, message?: string);
      code: number;
      message: string;
      isError(): boolean;

      static readonly Code: {
        SUCCESS: number;
        UNSUPPORTED: number;
        SERVER_ERROR: number;
        SERVER_BUSY: number;
        UPSTREAM_TIMEOUT: number;
        UPSTREAM_ERROR: number;
        RESOURCE_NOT_FOUND: number;
        RESOURCE_CONFLICT: number;
        RESOURCE_CLOSED: number;
        UPSTREAM_NOT_FOUND: number;
        UPSTREAM_UNAVAILABLE: number;
        SESSION_CONFLICT: number;
        SESSION_TIMEOUT: number;
        CLIENT_BAD_REQUEST: number;
        CLIENT_UNAUTHORIZED: number;
        CLIENT_FORBIDDEN: number;
        CLIENT_TIMEOUT: number;
        CLIENT_OVERRUN: number;
        CLIENT_BAD_TYPE: number;
        CLIENT_TOO_MANY: number;
      };
    }

    // ────────────────────────────────────────────────────────────────
    // Tunnels
    // ────────────────────────────────────────────────────────────────
    class Tunnel {
      connect(data?: string): void;
      disconnect(): void;
      sendMessage(...elements: unknown[]): void;
      isConnected(): boolean;
      uuid: string | null;
      receiveTimeout: number;
      unstableThreshold: number;
      onerror: ((status: Status) => void) | null;
      onstatechange: ((state: number) => void) | null;
      oninstruction: ((opcode: string, args: string[]) => void) | null;
      onuuid: ((uuid: string) => void) | null;
      state: number;

      static readonly CONNECTING: number;
      static readonly OPEN: number;
      static readonly CLOSED: number;
      static readonly UNSTABLE: number;

      static readonly INTERNAL_DATA_OPCODE: string;
    }

    namespace Tunnel {
      enum State {
        CONNECTING = 0,
        OPEN = 1,
        CLOSED = 2,
        UNSTABLE = 3,
      }
    }

    class WebSocketTunnel extends Tunnel {
      constructor(tunnelURL: string);
    }

    class HTTPTunnel extends Tunnel {
      constructor(
        tunnelURL: string,
        crossDomain?: boolean,
        extraTunnelHeaders?: Record<string, string>
      );
    }

    class ChainedTunnel extends Tunnel {
      constructor(...tunnels: Tunnel[]);
    }

    class StaticHTTPTunnel extends Tunnel {
      constructor(url: string, crossDomain?: boolean, extraTunnelHeaders?: Record<string, string>);
    }

    // ────────────────────────────────────────────────────────────────
    // Client
    // ────────────────────────────────────────────────────────────────
    class Client {
      constructor(tunnel: Tunnel);
      connect(data?: string): void;
      disconnect(): void;
      isConnected(): boolean;
      getDisplay(): Display;
      sendMouseState(state: Mouse.State, applyDisplayScale?: boolean): void;
      sendKeyEvent(pressed: 0 | 1, keysym: number): void;
      sendSize(width: number, height: number): void;
      sendTouchState(state: Touch.State): void;
      createArgumentValueStream(mimetype: string, name: string): OutputStream;
      createClipboardStream(mimetype: string): OutputStream;
      createAudioStream(mimetype: string): OutputStream;
      createFileStream(mimetype: string, filename: string): OutputStream;
      createPipeStream(mimetype: string, name: string): OutputStream;
      createOutputStream(): OutputStream;
      createObjectOutputStream(mimetype: string, name: string): OutputStream;
      requestObjectInputStream(index: number, name: string): void;
      endStream(index: number): void;
      exportState(): Record<string, unknown>;
      importState(state: Record<string, unknown>): void;
      getLayer(index: number): Display.VisibleLayer;
      onerror: ((status: Status) => void) | null;
      onstatechange: ((state: number) => void) | null;
      onsync: ((timestamp: number) => void) | null;
      onclipboard: ((stream: InputStream, mimetype: string) => void) | null;
      onfile: ((stream: InputStream, mimetype: string, filename: string) => void) | null;
      onfilesystem: ((object: GuacObject, name: string) => void) | null;
      onpipe: ((stream: InputStream, mimetype: string, name: string) => void) | null;
      onaudio: ((stream: InputStream, mimetype: string) => AudioPlayer | null) | null;
      onvideo:
        | ((
            stream: InputStream,
            layer: Display.VisibleLayer,
            mimetype: string
          ) => VideoPlayer | null)
        | null;
      onargv: ((stream: InputStream, mimetype: string, name: string) => void) | null;
      onrequired: ((parameters: string[]) => void) | null;
      onname: ((name: string) => void) | null;
    }

    namespace Client {
      enum State {
        IDLE = 0,
        CONNECTING = 1,
        WAITING = 2,
        CONNECTED = 3,
        DISCONNECTING = 4,
        DISCONNECTED = 5,
      }
    }

    // ────────────────────────────────────────────────────────────────
    // Display
    // ────────────────────────────────────────────────────────────────
    class Display {
      getElement(): HTMLElement;
      getWidth(): number;
      getHeight(): number;
      getDefaultLayer(): Display.VisibleLayer;
      getCursorLayer(): Display.VisibleLayer;
      createLayer(): Display.Layer;
      createBuffer(): Display.Layer;
      flush(callback?: () => void): void;
      scale(amount: number): void;
      getScale(): number;
      /** Returns a canvas containing the entire display with all layers composited. */
      flatten(): HTMLCanvasElement;

      // Cursor
      setCursor(
        hotspotX: number,
        hotspotY: number,
        layer: Display.Layer,
        srcx: number,
        srcy: number,
        srcw: number,
        srch: number
      ): void;
      showCursor(shown: boolean): void;
      moveCursor(x: number, y: number): void;
      cursorX: number;
      cursorY: number;

      // Drawing
      dispose(layer: Display.Layer): void;
      drawImage(layer: Display.Layer, x: number, y: number, image: CanvasImageSource): void;
      drawBlob(layer: Display.Layer, x: number, y: number, blob: Blob): void;
      drawStream(
        layer: Display.Layer,
        x: number,
        y: number,
        stream: InputStream,
        mimetype: string
      ): void;
      copy(
        srcLayer: Display.Layer,
        srcx: number,
        srcy: number,
        srcw: number,
        srch: number,
        dstLayer: Display.Layer,
        x: number,
        y: number
      ): void;
      transfer(
        srcLayer: Display.Layer,
        srcx: number,
        srcy: number,
        srcw: number,
        srch: number,
        dstLayer: Display.Layer,
        x: number,
        y: number,
        transferFunction: (src: number, dst: number) => number
      ): void;
      put(
        srcLayer: Display.Layer,
        srcx: number,
        srcy: number,
        srcw: number,
        srch: number,
        dstLayer: Display.Layer,
        x: number,
        y: number
      ): void;
      rect(layer: Display.Layer, x: number, y: number, w: number, h: number): void;
      clip(layer: Display.Layer): void;
      strokeColor(
        layer: Display.Layer,
        cap: string,
        join: string,
        thickness: number,
        r: number,
        g: number,
        b: number,
        a: number
      ): void;
      fillColor(layer: Display.Layer, r: number, g: number, b: number, a: number): void;
      strokeLayer(
        layer: Display.Layer,
        cap: string,
        join: string,
        thickness: number,
        srcLayer: Display.Layer
      ): void;
      fillLayer(layer: Display.Layer, srcLayer: Display.Layer): void;
      push(layer: Display.Layer): void;
      pop(layer: Display.Layer): void;
      reset(layer: Display.Layer): void;
      transform(
        layer: Display.Layer,
        a: number,
        b: number,
        c: number,
        d: number,
        e: number,
        f: number
      ): void;
      setTransform(
        layer: Display.Layer,
        a: number,
        b: number,
        c: number,
        d: number,
        e: number,
        f: number
      ): void;
      setChannelMask(layer: Display.Layer, mask: number): void;
      setMiterLimit(layer: Display.Layer, limit: number): void;
      resize(layer: Display.Layer, width: number, height: number): void;
      move(
        layer: Display.VisibleLayer,
        parent: Display.VisibleLayer,
        x: number,
        y: number,
        z: number
      ): void;
      shade(layer: Display.VisibleLayer, alpha: number): void;
      setSize(width: number, height: number): void;

      onresize: ((width: number, height: number) => void) | null;
      oncursor: ((canvas: HTMLCanvasElement, x: number, y: number) => void) | null;
      /**
       * Fires after the display has finished processing a batch of draw
       * instructions and committed them to its layers. Used by Strata to
       * auto-schedule ghost-pixel sweeps after in-session window animations
       * (minimise/maximise) that don't change the desktop resolution.
       */
      onflush: (() => void) | null;
    }

    namespace Display {
      class Layer {
        width: number;
        height: number;
        autosize: number;
        getCanvas(): HTMLCanvasElement;
        toCanvas(): HTMLCanvasElement;
        resize(width: number, height: number): void;
      }
      class VisibleLayer extends Layer {
        x: number;
        y: number;
        z: number;
        alpha: number;
        matrix: number[];
        parent: VisibleLayer | null;
        getElement(): HTMLElement;
      }
    }

    // ────────────────────────────────────────────────────────────────
    // Streams
    // ────────────────────────────────────────────────────────────────
    class InputStream {
      index: number;
      sendAck(message: string, code: number): void;
      onblob: ((data: string) => void) | null;
      onend: (() => void) | null;
    }

    class OutputStream {
      index: number;
      sendBlob(data: string): void;
      sendEnd(): void;
      onack: ((status: Status) => void) | null;
    }

    class StringWriter {
      constructor(stream: OutputStream);
      sendText(text: string): void;
      sendEnd(): void;
      onack: ((status: Status) => void) | null;
    }

    class StringReader {
      constructor(stream: InputStream);
      ontext: ((text: string) => void) | null;
      onend: (() => void) | null;
    }

    class BlobReader {
      constructor(stream: InputStream, mimetype: string);
      getLength(): number;
      getBlob(): Blob;
      onend: (() => void) | null;
      onprogress: ((length: number) => void) | null;
    }

    class BlobWriter {
      constructor(stream: OutputStream);
      sendBlob(blob: Blob): void;
      sendEnd(): void;
      oncomplete: ((blob: Blob) => void) | null;
      onerror: ((blob: Blob, offset: number, error: Status) => void) | null;
      onprogress: ((blob: Blob, offset: number) => void) | null;
      onack: ((status: Status) => void) | null;
    }

    class ArrayBufferReader {
      constructor(stream: InputStream);
      ondata: ((buffer: ArrayBuffer) => void) | null;
      onend: (() => void) | null;
    }

    class ArrayBufferWriter {
      constructor(stream: OutputStream);
      sendData(data: ArrayBuffer | ArrayBufferView): void;
      sendEnd(): void;
      onack: ((status: Status) => void) | null;
    }

    class JSONReader {
      constructor(stream: InputStream);
      getLength(): number;
      getJSON(): unknown;
      onprogress: ((length: number) => void) | null;
      onend: (() => void) | null;
    }

    class DataURIReader {
      constructor(stream: InputStream, mimetype: string);
      getURI(): string;
      onend: (() => void) | null;
    }

    // ────────────────────────────────────────────────────────────────
    // Filesystem objects
    // ────────────────────────────────────────────────────────────────
    class GuacObject {
      index: number;
      requestInputStream(
        name: string,
        bodyCallback: (stream: InputStream, mimetype: string) => void
      ): void;
      createOutputStream(mimetype: string, name: string): OutputStream;
      onbody: ((stream: InputStream, mimetype: string, name: string) => void) | null;
      onundefine: (() => void) | null;
    }

    namespace GuacObject {
      const ROOT_STREAM: string;
      const STREAM_INDEX_MIMETYPE: string;
    }

    // ────────────────────────────────────────────────────────────────
    // Mouse / Touch / Keyboard
    // ────────────────────────────────────────────────────────────────
    namespace Mouse {
      class State {
        constructor(
          x: number,
          y: number,
          left: boolean,
          middle: boolean,
          right: boolean,
          up: boolean,
          down: boolean
        );
        x: number;
        y: number;
        left: boolean;
        middle: boolean;
        right: boolean;
        up: boolean;
        down: boolean;
        fromClientPosition(element: HTMLElement, clientX: number, clientY: number): void;
      }

      class Event {
        type: string;
        state: State;
        stopPropagation(): void;
        preventDefault(): void;
      }

      class Touchpad {
        constructor(element: HTMLElement);
        onEach(events: string[], handler: (e: Event) => void): void;
        onmousedown: ((state: State) => void) | null;
        onmouseup: ((state: State) => void) | null;
        onmousemove: ((state: State) => void) | null;
        onmouseout: (() => void) | null;
      }

      class Touchscreen {
        constructor(element: HTMLElement);
        onEach(events: string[], handler: (e: Event) => void): void;
        onmousedown: ((state: State) => void) | null;
        onmouseup: ((state: State) => void) | null;
        onmousemove: ((state: State) => void) | null;
        onmouseout: (() => void) | null;
      }
    }

    class Mouse {
      constructor(element: HTMLElement);
      onEach(events: string[], handler: (e: Mouse.Event) => void): void;
      onmousedown: ((state: Mouse.State) => void) | null;
      onmouseup: ((state: Mouse.State) => void) | null;
      onmousemove: ((state: Mouse.State) => void) | null;
      onmouseout: (() => void) | null;
      currentState: Mouse.State;
      touchMouseThreshold: number;
      scrollThreshold: number;
      PIXELS_PER_LINE: number;
      PIXELS_PER_PAGE: number;
    }

    namespace Touch {
      class State {
        constructor(template?: Partial<State>);
        id: number;
        x: number;
        y: number;
        radiusX: number;
        radiusY: number;
        angle: number;
        force: number;
      }
      class Event {
        type: string;
        state: State;
        touches: State[];
        changedTouches: State[];
      }
    }

    class Touch {
      constructor(element: HTMLElement);
      onEach(events: string[], handler: (e: Touch.Event) => void): void;
      ontouchstart: ((e: Touch.Event) => void) | null;
      ontouchmove: ((e: Touch.Event) => void) | null;
      ontouchend: ((e: Touch.Event) => void) | null;
    }

    class Keyboard {
      constructor(element: HTMLElement | Document);
      onkeydown: ((keysym: number) => boolean | void) | null;
      onkeyup: ((keysym: number) => void) | null;
      type(text: string): void;
      press(keysym: number): boolean;
      release(keysym: number): void;
      reset(): void;
      listenTo(element: HTMLElement | Document): void;
    }

    class InputSink {
      constructor();
      getElement(): HTMLElement;
      focus(): void;
    }

    class KeyEventInterpreter {
      constructor(startTimestamp?: number);
      handleKeyEvent(args: string[]): void;
      getEvents(): KeyEventInterpreter.KeyEvent[];
    }

    namespace KeyEventInterpreter {
      class KeyEvent {
        keysym: number;
        pressed: boolean;
        timestamp: number;
      }
    }

    class OnScreenKeyboard {
      constructor(layout: OnScreenKeyboard.Layout);
      getElement(): HTMLElement;
      resize(width: number): void;
      onkeydown: ((keysym: number) => void) | null;
      onkeyup: ((keysym: number) => void) | null;
    }

    namespace OnScreenKeyboard {
      class Layout {
        constructor(template: Partial<Layout>);
      }
    }

    // ────────────────────────────────────────────────────────────────
    // Audio / Video
    // ────────────────────────────────────────────────────────────────
    class RawAudioFormat {
      constructor(template: { bytesPerSample: number; channels: number; rate: number });
      bytesPerSample: number;
      channels: number;
      rate: number;
      static parse(mimetype: string): RawAudioFormat | null;
    }

    abstract class AudioPlayer {
      sync(): void;
    }

    namespace AudioPlayer {
      function getInstance(stream: InputStream, mimetype: string): AudioPlayer | null;
      function isSupportedType(mimetype: string): boolean;
      function getSupportedTypes(): string[];
    }

    class RawAudioPlayer extends AudioPlayer {
      constructor(stream: InputStream, mimetype: string);
    }

    abstract class AudioRecorder {
      onclose: (() => void) | null;
      onerror: ((message: string) => void) | null;
    }

    namespace AudioRecorder {
      function getInstance(stream: OutputStream, mimetype: string): AudioRecorder | null;
      function isSupportedType(mimetype: string): boolean;
      function getSupportedTypes(): string[];
    }

    class RawAudioRecorder extends AudioRecorder {
      constructor(stream: OutputStream, mimetype: string);
    }

    abstract class VideoPlayer {
      sync(): void;
    }

    namespace VideoPlayer {
      function getInstance(
        stream: InputStream,
        layer: Display.VisibleLayer,
        mimetype: string
      ): VideoPlayer | null;
      function isSupportedType(mimetype: string): boolean;
      function getSupportedTypes(): string[];
    }

    /** WebCodecs-based H.264 NAL stream decoder (1.6.0+). */
    class H264Decoder {
      constructor(canvas: HTMLCanvasElement);
      decode(data: Uint8Array): void;
      close(): void;
    }

    // ────────────────────────────────────────────────────────────────
    // Misc
    // ────────────────────────────────────────────────────────────────
    class Position {
      constructor(x?: number, y?: number);
      x: number;
      y: number;
      fromClientPosition(element: HTMLElement, clientX: number, clientY: number): void;
    }

    class Parser {
      receive(data: string, isBuffered?: boolean): void;
      oninstruction: ((opcode: string, args: string[]) => void) | null;
    }

    class UTF8Parser {
      decode(buffer: ArrayBuffer): string;
    }

    class IntegerPool {
      next(): number;
      free(integer: number): void;
    }

    class Event {
      constructor(type: string);
      type: string;
      timestamp: number;
      getEvents(): Event[];
    }

    namespace Event {
      class Target {
        on(type: string, listener: (event: Event) => void): void;
        off(type: string, listener: (event: Event) => void): void;
        dispatch(event: Event): void;
      }
    }

    class SessionRecording {
      constructor(tunnel: Tunnel | Blob);
      connect(data?: string): void;
      disconnect(): void;
      getDuration(): number;
      seek(position: number, callback?: () => void): void;
      play(): void;
      pause(): void;
      isPlaying(): boolean;
      getPosition(): number;
      getDisplay(): Display;
      onplay: (() => void) | null;
      onpause: (() => void) | null;
      onseek: ((millis: number, current: number, total: number) => void) | null;
      onprogress: ((millis: number, parsedSize: number) => void) | null;
    }

    /** Library version string exposed by 1.6.x builds. */
    const API_VERSION: string;
  }

  export default Guacamole;
}
declare module "guacamole-common-js" {
  namespace Guacamole {
    class Status {
      code: number;
      message: string;
      isError(): boolean;
    }

    class Tunnel {
      connect(data?: string): void;
      disconnect(): void;
      sendMessage(...elements: unknown[]): void;
      onerror: ((status: Status) => void) | null;
      onstatechange: ((state: number) => void) | null;
      oninstruction: ((opcode: string, args: string[]) => void) | null;
      state: number;

      static readonly CONNECTING: number;
      static readonly OPEN: number;
      static readonly CLOSED: number;
      static readonly UNSTABLE: number;
    }

    class WebSocketTunnel extends Tunnel {
      constructor(tunnelURL: string);
    }

    class HTTPTunnel extends Tunnel {
      constructor(
        tunnelURL: string,
        crossDomain?: boolean,
        extraTunnelHeaders?: Record<string, string>
      );
    }

    class Client {
      constructor(tunnel: Tunnel);
      connect(data?: string): void;
      disconnect(): void;
      getDisplay(): Display;
      sendMouseState(state: Mouse.State, applyDisplayScale?: boolean): void;
      sendKeyEvent(pressed: 0 | 1, keysym: number): void;
      sendSize(width: number, height: number): void;
      createArgumentValueStream(mimetype: string, name: string): OutputStream;
      createClipboardStream(mimetype: string): OutputStream;
      createOutputStream(): OutputStream;
      onerror: ((status: Status) => void) | null;
      onstatechange: ((state: number) => void) | null;
      onclipboard: ((stream: InputStream, mimetype: string) => void) | null;
      onfile: ((stream: InputStream, mimetype: string, filename: string) => void) | null;
      onfilesystem: ((object: GuacObject, name: string) => void) | null;
      onrequired: ((parameters: string[]) => void) | null;
    }

    class Display {
      getElement(): HTMLElement;
      getWidth(): number;
      getHeight(): number;
      scale(amount: number): void;
      getDefaultLayer(): Display.VisibleLayer;
      /** Returns a canvas containing the entire display with all layers composited. */
      flatten(): HTMLCanvasElement;
      onresize: ((width: number, height: number) => void) | null;
      /**
       * Fires after the display has finished processing a batch of draw
       * instructions and committed them to its layers. Used by Strata to
       * auto-schedule ghost-pixel sweeps after in-session window animations
       * (minimise/maximise) that don't change the desktop resolution.
       */
      onflush: (() => void) | null;
    }

    namespace Display {
      class VisibleLayer {
        width: number;
        height: number;
        /** Returns the underlying HTML canvas element for this layer. */
        getCanvas(): HTMLCanvasElement;
        /** Returns the container element for this layer (div wrapping the canvas). */
        getElement(): HTMLElement;
      }
    }

    class InputStream {
      onblob: ((data: string) => void) | null;
      onend: (() => void) | null;
    }

    class OutputStream {
      sendBlob(data: string): void;
      sendEnd(): void;
      onack: ((status: Status) => void) | null;
    }

    class StringWriter {
      constructor(stream: OutputStream);
      sendText(text: string): void;
      sendEnd(): void;
    }

    class StringReader {
      constructor(stream: InputStream);
      ontext: ((text: string) => void) | null;
      onend: (() => void) | null;
    }

    class BlobReader {
      constructor(stream: InputStream, mimetype: string);
      getBlob(): Blob;
      onend: (() => void) | null;
      onprogress: ((length: number) => void) | null;
    }

    class BlobWriter {
      constructor(stream: OutputStream);
      sendBlob(blob: Blob): void;
      sendEnd(): void;
      oncomplete: ((blob: Blob) => void) | null;
      onerror: ((blob: Blob, offset: number, error: Status) => void) | null;
      onprogress: ((blob: Blob, offset: number) => void) | null;
      onack: ((status: Status) => void) | null;
    }

    class GuacObject {
      index: number;
      requestInputStream(
        name: string,
        bodyCallback: (stream: InputStream, mimetype: string) => void
      ): void;
      createOutputStream(mimetype: string, name: string): OutputStream;
      onbody: ((stream: InputStream, mimetype: string, name: string) => void) | null;
      onundefine: (() => void) | null;
    }

    /** Root stream path constant */
    namespace GuacObject {
      const ROOT_STREAM: string;
      const STREAM_INDEX_MIMETYPE: string;
    }

    namespace Mouse {
      class State {
        constructor(
          x: number,
          y: number,
          left: boolean,
          middle: boolean,
          right: boolean,
          up: boolean,
          down: boolean
        );
        x: number;
        y: number;
        left: boolean;
        middle: boolean;
        right: boolean;
        up: boolean;
        down: boolean;
      }

      class Event {
        state: State;
      }

      class Touchscreen {
        constructor(element: HTMLElement);
        onEach(events: string[], handler: (e: Event) => void): void;
        onmousedown: ((state: State) => void) | null;
        onmouseup: ((state: State) => void) | null;
        onmousemove: ((state: State) => void) | null;
      }
    }

    class Mouse {
      constructor(element: HTMLElement);
      onEach(events: string[], handler: (e: Mouse.Event) => void): void;
      onmousedown: ((state: Mouse.State) => void) | null;
      onmouseup: ((state: Mouse.State) => void) | null;
      onmousemove: ((state: Mouse.State) => void) | null;
    }

    class Keyboard {
      constructor(element: HTMLElement | Document);
      onkeydown: ((keysym: number) => boolean | void) | null;
      onkeyup: ((keysym: number) => void) | null;
      reset(): void;
    }
  }

  export default Guacamole;
}
