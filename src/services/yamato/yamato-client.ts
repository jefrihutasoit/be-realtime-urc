import { Socket } from "node:net";

/**
 * Yamato Dataweigh Alpha Plus over TCP (same protocol as RS232, only the transport differs). Port of the
 * SCADA C# YamatoTcpDriver, DS command only. One transaction at a time per connection:
 *
 *   PC → DA ENQ
 *   PC → DA STX "DS" MCSIDE ETX BCC        DW → DA ACK '1'      PC → DA EOT
 *   PC → DA ACK '0'                         DW → DA STX "DS" MCSIDE [324] ETX BCC   (332 bytes)
 *   PC → DA ACK '1'                         DW → DA EOT (best effort)
 *
 * Like the C# driver: ACK0 after ENQ and the scale's ENQ are not waited for, the ACK byte is 0x10 (not
 * ASCII ACK), the data packet is read by length (the payload may contain 0x03), and a packet with a BCC
 * error is answered with NAK but still used.
 */

const DA = [0x44, 0x41];
const STX = 0x02;
const ETX = 0x03;
const EOT = 0x04;
const ENQ = 0x05;
const ACK = 0x10;
const NAK = 0x15;
const ACK0 = 0x30;
const ACK1 = 0x31;

const DS_PAYLOAD = 324;
const IO_TIMEOUT_MS = 5000;
const EOT_TIMEOUT_MS = 1000;
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 200;

export class TimeoutError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bytes received on a socket, read in exact amounts with a deadline. */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  closed = false;

  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  /** Drops whatever is buffered (stale bytes). */
  drain() {
    this.buf = Buffer.alloc(0);
  }

  private async waitFor(count: number, deadline: number) {
    while (this.buf.length < count) {
      if (this.closed) throw new Error("Connection closed by remote");
      const left = deadline - Date.now();
      if (left <= 0) throw new TimeoutError(`Timeout waiting for ${count} byte(s) (got ${this.buf.length})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  async read(count: number, deadline: number) {
    await this.waitFor(count, deadline);
    const out = this.buf.subarray(0, count);
    this.buf = this.buf.subarray(count);
    return out;
  }

  /** Reads byte by byte until the last bytes equal `pattern`; false on timeout. */
  async seek(pattern: number[], deadline: number) {
    const win: number[] = [];
    try {
      for (;;) {
        win.push((await this.read(1, deadline))[0]);
        if (win.length > pattern.length) win.shift();
        if (win.length === pattern.length && win.every((b, i) => b === pattern[i])) return true;
      }
    } catch (err) {
      if (err instanceof TimeoutError) return false;
      throw err;
    }
  }
}

export function buildCommandPacket(command: string, mcSide: string) {
  const text = Buffer.from(command + mcSide, "ascii");
  let bcc = ETX;
  for (const b of text) bcc ^= b;
  return Buffer.from([...DA, STX, ...text, ETX, bcc]);
}

/** BCC = XOR from after STX through ETX; ETX is always second to last (never searched for). */
export function validBcc(packet: Buffer) {
  if (packet.length < 6) return false;
  const stx = packet.indexOf(STX);
  const etx = packet.length - 2;
  if (stx < 0 || packet[etx] !== ETX) return false;
  let bcc = 0;
  for (let i = stx + 1; i <= etx; i++) bcc ^= packet[i];
  return bcc === packet[packet.length - 1];
}

export class YamatoClient {
  private socket: Socket | null = null;
  private reader: ByteReader | null = null;

  constructor(
    readonly host: string,
    readonly port: number,
    readonly mcSide: string
  ) {}

  get connected() {
    return !!this.socket && !this.reader?.closed;
  }

  connect() {
    this.close();
    return new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      const reader = new ByteReader();
      const fail = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10_000);
      socket.setTimeout(IO_TIMEOUT_MS, () => fail(new TimeoutError(`Connect timeout ${this.host}:${this.port}`)));
      socket.once("error", fail);
      socket.connect(this.port, this.host, () => {
        socket.setTimeout(0);
        socket.off("error", fail);
        // Later errors end the connection; the next transaction sees it closed.
        socket.on("error", () => reader.close());
        socket.on("close", () => reader.close());
        socket.on("data", (chunk: Buffer) => reader.push(chunk));
        this.socket = socket;
        this.reader = reader;
        resolve();
      });
    });
  }

  close() {
    this.reader?.close();
    this.socket?.destroy();
    this.socket = null;
    this.reader = null;
  }

  private send(bytes: number[] | Buffer) {
    const socket = this.socket;
    if (!socket || this.reader?.closed) throw new Error("Not connected");
    socket.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }

  private sendAck(toggle: 0 | 1) {
    this.send([...DA, ACK, toggle === 0 ? ACK0 : ACK1]);
  }

  /** One DS read with up to MAX_RETRY attempts; returns the 324-character payload. */
  async readDs(): Promise<string> {
    let last: unknown;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        return await this.transaction("DS");
      } catch (err) {
        last = err;
        if (!this.connected) break;
        if (attempt < MAX_RETRY) {
          this.reader?.drain();
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
    throw new Error(`DS failed after retries: ${last instanceof Error ? last.message : String(last)}`);
  }

  private async transaction(command: string) {
    const reader = this.reader;
    if (!reader) throw new Error("Not connected");

    // Phase 1: PC → scale
    this.send([...DA, ENQ]);
    this.send(buildCommandPacket(command, this.mcSide));
    if (!(await reader.seek([...DA, ACK, ACK1], Date.now() + IO_TIMEOUT_MS))) {
      throw new TimeoutError(`No ACK1 after ${command}`);
    }
    this.send([...DA, EOT]);

    // Phase 2: scale → PC
    this.sendAck(0);
    const deadline = Date.now() + IO_TIMEOUT_MS;
    if (!(await reader.seek([...DA, STX], deadline))) throw new TimeoutError(`Timeout receiving ${command} packet`);
    const rest = await reader.read(2 + 1 + DS_PAYLOAD + 1 + 1, deadline);
    const packet = Buffer.concat([Buffer.from([...DA, STX]), rest]);
    if (!validBcc(packet)) this.send([...DA, NAK]);
    const payload = packet.toString("ascii", 6, packet.length - 2);
    this.sendAck(1);

    await reader.seek([...DA, EOT], Date.now() + EOT_TIMEOUT_MS).catch(() => false);
    reader.drain();
    return payload;
  }
}
