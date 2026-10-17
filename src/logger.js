// Only internal event names and allowlisted scalar metrics reach stdout.
const allowed = new Set(['code','state','attempt','delayMs','rssMiB','heapMiB','packets','keepAlives','mods','mappings','channels','bytes','durationMs','id','count','dimension',
  'rxBytes','txBytes','pendingFrameBytes','pendingFrameReceived','pendingHeaderBytes','pendingPacketId','inboundIdleMs','tcpIdleMs','socketPaused','outboundBytes']);
export class Logger {
  constructor(write = line => console.log(line)) { this.write = write; }
  event(event, fields = {}) {
    const safe = Object.fromEntries(Object.entries(fields).filter(([k,v]) => allowed.has(k) && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && /^[A-Z0-9_ .:-]{1,80}$/i.test(v)))));
    this.write(JSON.stringify({ time: new Date().toISOString(), event, ...safe }));
  }
}
