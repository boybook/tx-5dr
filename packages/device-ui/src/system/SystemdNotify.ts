export class SystemdNotify {
  ready(): void { this.send('READY=1'); }
  stopping(): void { this.send('STOPPING=1'); }
  status(text: string): void { this.send(`STATUS=${text}`); }
  private send(message: string): void {
    if (!process.env.NOTIFY_SOCKET) return;
    // The production systemd datagram sender will live here; keeping this no-op is safe for dev and tests.
    if (process.env.TX5DR_DEVICE_UI_VERBOSE) console.error(`[systemd-notify] ${message}`);
  }
}
