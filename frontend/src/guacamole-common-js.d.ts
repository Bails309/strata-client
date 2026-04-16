declare module 'guacamole-common-js' {
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
      constructor(tunnelURL: string, crossDomain?: boolean, extraTunnelHeaders?: Record<string, string>);
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
      onresize: ((width: number, height: number) => void) | null;
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
      requestInputStream(name: string, bodyCallback: (stream: InputStream, mimetype: string) => void): void;
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
        constructor(x: number, y: number, left: boolean, middle: boolean, right: boolean, up: boolean, down: boolean);
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
