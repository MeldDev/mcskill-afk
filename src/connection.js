import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { Reader, PacketCodec, ProtocolError, concat, packet, varint, string, shortBuffer } from './codec.js';
import { encryptionResponse, serverHash, aes } from './encryption.js';
import { McSkillSessionService } from './auth.js';
import { ForgeHandshakeHandler } from './forge.js';
import { GameSessionHandler } from './game.js';
import { disconnectCode } from './disconnect.js';
import { validateChat } from './chat.js';
export class ConnectionError extends Error {
  constructor(code, retryable = true) { super(code); this.code = code; this.retryable = retryable; }
}
export class MinecraftConnection extends EventEmitter {
  constructor(c, session, mods, log, auth = new McSkillSessionService(c)) {
    super(); Object.assign(this, { c, session, mods, log, auth });
    this.state = 'LOGIN'; this.codec = new PacketCodec(c.maxPacket); this.packets = 0;
    this.frameHistory=[];
    this.abort = new AbortController();
  }
  start(mode = 'afk', signal) {
    if (this.started) throw new Error('Connection already started'); this.started = true; this.mode = mode;
    this.lastPacketAt = this.lastTcpAt = performance.now();
    return new Promise(resolve => {
      this.resolve = resolve;
      this.onAbort = () => this.close(new ConnectionError('STOPPED', false));
      this.outerSignal = signal;
      if (signal?.aborted) return this.onAbort();
      signal?.addEventListener('abort', this.onAbort, { once: true });
      this.socket = net.createConnection({ host: this.c.host, port: this.c.port });
      this.socket.setNoDelay(true); this.socket.setTimeout(this.c.idleTimeout);
      this.socket.setKeepAlive(true,30000);
      this.socket.on('timeout', () => this.close(new ConnectionError('IDLE_TIMEOUT')));
      this.socket.on('error', () => this.close(new ConnectionError('NETWORK')));
      this.socket.on('close', () => this.finish(this.failure || new ConnectionError('REMOTE_CLOSED')));
      this.socket.on('data', b => {
        if (this.closed) return;
        this.lastTcpAt=performance.now();
        try {
          if (this.authPending) throw new ProtocolError('Server data during pending encryption');
          this.codec.feed(this.crypto ? this.crypto.decrypt.update(b) : b, frame => {
            if (!this.closed) this.receive(frame);
          });
        } catch (e) { this.close(e); }
      });
      this.socket.once('connect', () => {
        this.log.event('tcp_connected');
        const port = Buffer.alloc(2); port.writeUInt16BE(this.c.port);
        this.send(0, concat(varint(5), string(this.c.host + '\0FML\0'), port, varint(2)));
        this.send(0, string(this.session.username));
      });
      this.deadline = setTimeout(() => this.close(new ConnectionError('LOGIN_TIMEOUT')), this.c.timeout);
      this.ticker = setInterval(() => {
        try { if (!this.checkInboundTimeout()) this.game?.tick(); }
        catch (e) { this.close(e); }
      }, 50);
      this.metrics = setInterval(() => {
        const m = process.memoryUsage(); this.log.event('metrics', { rssMiB: Math.round(m.rss / 1048576), heapMiB: Math.round(m.heapUsed / 1048576), packets: this.packets, keepAlives: this.game?.keepAlives || 0,...this.inboundDiagnostics() });
      }, 60000);
    });
  }
  inboundDiagnostics(now=performance.now()) {
    const elapsed=then=>Number.isFinite(then)?Math.max(0,Math.round(now-then)):0;
    return {...this.codec.progress(),rxBytes:this.socket?.bytesRead||0,txBytes:this.socket?.bytesWritten||0,
      inboundIdleMs:elapsed(this.lastPacketAt),tcpIdleMs:elapsed(this.lastTcpAt),
      socketPaused:this.socket?.isPaused?.()||false,outboundBytes:this.socket?.writableLength||0};
  }
  checkInboundTimeout(now = performance.now()) {
    // net.Socket's inactivity timer is also renewed by outgoing writes.
    // Only complete inbound packets prove that the server is still talking.
    if (!this.closed && now - this.lastPacketAt >= this.c.idleTimeout) {
      const diagnostics=this.inboundDiagnostics(now);
      const state=diagnostics.socketPaused?'SOCKET_PAUSED':diagnostics.pendingFrameBytes?'WAITING_FRAME':diagnostics.pendingHeaderBytes?'WAITING_HEADER':'NO_COMPLETE_PACKETS';
      this.log.event('inbound_stalled',{state,id:this.lastId??-1,packets:this.packets,keepAlives:this.game?.keepAlives||0,...diagnostics});
      this.close(new ConnectionError('INBOUND_TIMEOUT'));
    }
    return !!this.closed;
  }
  send(id, body) {
    if (this.closed) return;
    const b = packet(id, body);
    if (this.socket.writableLength + b.length > 262144) throw new ConnectionError('OUTBOUND_QUEUE_LIMIT');
    this.socket.write(this.crypto ? this.crypto.encrypt.update(b) : b);
  }
  plugin(channel, data) { this.send(0x17, concat(string(channel), shortBuffer(data))); }
  sendChat(text) {
    if (!this.ready || this.closed || !this.game?.position || !this.forge?.done) throw new Error('NOT_IN_WORLD');
    validateChat(text);
    if (this.lastChatAt && Date.now()-this.lastChatAt<1000) throw new Error('CHAT_RATE_LIMIT');
    this.send(0x01,string(text));this.lastChatAt=Date.now();
  }
  receive(frame) {
    this.packets++;
    this.lastPacketAt = performance.now();
    // Set frame metadata before decoding; an invalid ID must not report the
    // previous packet's ID, size or receive time.
    this.lastId = -1; this.lastSize = frame.length;
    const r = new Reader(frame);
    let id;
    try { id = r.vi(); }
    catch (error) {
      if (!(error instanceof ProtocolError) || this.state !== 'PLAY') throw error;
      // The outer frame is complete. Discard exactly this frame, without
      // guessing an ID, scanning for a new boundary or touching cipher state.
      this.frameHistory.push({id:-1,bytes:frame.length,state:'INVALID_PACKET_ID'});
      if(this.frameHistory.length>16)this.frameHistory.shift();
      this.ignoredPacketIds = (this.ignoredPacketIds || 0) + 1;
      if(this.ignoredPacketIds === 1 || this.ignoredPacketIds % 1024 === 0)
        this.log.event('packet_ignored',{state:'INVALID_PACKET_ID',bytes:frame.length,count:this.ignoredPacketIds});
      return;
    }
    this.lastId = id;
    this.frameHistory.push({id,bytes:frame.length});
    if(this.frameHistory.length>16)this.frameHistory.shift();
    if ((this.state === 'LOGIN' && id === 0) || (this.state === 'PLAY' && id === 0x40)) {
      // Parse for validity but don't log arbitrary server text, which can echo secrets.
      const code = disconnectCode(r.str(),this.state); r.end(); this.log.event('server_disconnect', { state: this.state, code });
      throw new ConnectionError(code, !['SERVER_DISCONNECT','SERVER_SESSION_EXPIRED'].includes(code));
    }
    if (this.state === 'LOGIN') {
      if (id === 1) {
        if (this.encryptionRequested) throw new ProtocolError('Duplicate encryption request');
        this.encryptionRequested = true;
        const serverId = r.str(20), key = r.shortBytes(), verify = r.shortBytes(); r.end();
        if (key.length > 2048 || verify.length < 1 || verify.length > 256) throw new ProtocolError('Invalid encryption request');
        this.log.event('encryption_request');
        if (this.mode === 'probe') { this.reached = true; return this.close(); }
        this.authPending = true; this.socket.pause();
        this.authenticate(serverId, key, verify).catch(e => this.close(e));
      } else if (id === 2) {
        if (!this.crypto) throw new ProtocolError('Unencrypted Login Success rejected');
        const uuid = r.str(36).replaceAll('-', '').toLowerCase(), name = r.str(16); r.end();
        if (uuid !== this.session.uuid || name !== this.session.username) throw new ProtocolError('Login profile mismatch');
        this.state = 'PLAY'; this.log.event('login_success'); this.emit('login');
        if (this.mode === 'auth-test') { this.reached = true; return this.close(); }
        this.forge = new ForgeHandshakeHandler({ send: (ch, d) => this.plugin(ch, d), mods: this.mods, profile: this.c.forgeProfile, log: this.log, resetting: () => {
          this.game.inventory.invalidate();
          this.ready = false; this.hasJoin = false; this.hasPosition = false; this.game.position = null;
          clearTimeout(this.deadline); clearTimeout(this.testTimer);
          this.deadline = setTimeout(() => this.close(new ConnectionError('FORGE_RESET_TIMEOUT')), this.c.timeout);
        }, complete: () => {
          this.log.event('forge_complete'); this.checkReady();
        } });
        this.game = new GameSessionHandler({ send: (id, d) => this.send(id, d), plugin: (ch, d) => this.plugin(ch, d), forge: this.forge, log: this.log,
          chat: text => this.emit('chat',text),inventoryStatus: status => this.emit('inventory_status',status),
          joined: () => { this.hasJoin = true; this.checkReady(); }, positioned: () => { this.hasPosition = true; this.checkReady(); } });
      } else throw new ProtocolError('Unexpected login packet');
    } else this.game.handle(id, r.bytes(r.remaining));
  }
  async authenticate(serverId, key, verify) {
    const result = encryptionResponse(key, verify);
    await this.auth.join(this.session, serverHash(serverId, result.secret, key), this.abort.signal);
    if (this.closed) return;
    this.log.event('session_join_accepted');
    // Encryption Response itself is plaintext. All following bytes use AES CFB8.
    this.send(1, result.body); this.crypto = aes(result.secret);
    result.secret.fill(0); this.authPending = false; this.socket.resume();
  }
  checkReady() {
    if (this.ready || !this.hasJoin || !this.hasPosition || !this.forge.done) return;
    this.ready = true; this.readyAt = Date.now(); clearTimeout(this.deadline);
    this.log.event('world_ready'); this.emit('ready');
    if (this.mode === 'forge-test') this.testTimer = setTimeout(() => {
      if (!this.game.keepAlives) return this.close(new ConnectionError('NO_KEEPALIVE_OBSERVED', false));
      this.reached = true; this.close();
    }, this.c.testDuration);
  }
  close(error) {
    if (this.closed) return;
    if (error instanceof ProtocolError) {
      // Reconnect from a clean TCP/cipher/framing state after an in-world
      // decoding failure. Never skip bytes or fabricate support for a packet.
      error.retryable = this.ready === true;
      this.log.event('protocol_error', { state: error.message, id: this.lastId, bytes: this.lastSize,...this.inboundDiagnostics() });
      // Bounded metadata only: no packet contents, chat, access tokens or keys.
      this.frameHistory.forEach((frame,index)=>this.log.event('packet_boundary',{count:index+1,...frame}));
    }
    this.closed = true; this.failure = error;
    this.abort.abort();
    if (this.socket) this.socket.destroy();
    this.finish(error);
  }
  finish(error) {
    if (this.finished) return; this.finished = true; this.closed = true;
    clearTimeout(this.deadline); clearTimeout(this.testTimer); clearInterval(this.ticker); clearInterval(this.metrics);
    this.abort.abort(); this.outerSignal?.removeEventListener('abort', this.onAbort);
    this.game?.inventory.cancel('DROP_CANCELLED');this.emit('ended');
    this.resolve?.({ error, reached: !!this.reached, ready: !!this.ready, stableMs: this.readyAt ? Date.now() - this.readyAt : 0, packets: this.packets, keepAlives: this.game?.keepAlives || 0 });
  }
}
