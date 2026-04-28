import type { RealtimeScope, RealtimeSessionDirection, RealtimeTransportOffer } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';
import { normalizeWsUrl } from '../utils/config';

const logger = createLogger('RtcDataAudioClient');
const RTC_DATA_AUDIO_CONNECT_TIMEOUT_MS = 5000;
const RTC_DATA_AUDIO_DEFAULT_STUN = 'stun:stun.l.google.com:19302';

interface RtcDataAudioClientOptions {
  offer: RealtimeTransportOffer;
  iceServers?: string[];
  onBinaryMessage?: (payload: ArrayBuffer) => void;
  onControlMessage?: (payload: unknown) => void;
  onClose?: () => void;
}

type SignalMessage = {
  type?: string;
  sdp?: string;
  sdpType?: RTCSdpType;
  candidate?: string;
  mid?: string;
  transport?: string;
  direction?: RealtimeSessionDirection;
  scope?: RealtimeScope;
  participantIdentity?: string | null;
};

export class RtcDataAudioClient {
  private readonly offer: RealtimeTransportOffer;
  private readonly iceServers: string[];
  private readonly onBinaryMessage?: (payload: ArrayBuffer) => void;
  private readonly onControlMessage?: (payload: unknown) => void;
  private readonly onClose?: () => void;
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private intentionallyClosed = false;
  private ready = false;

  constructor(options: RtcDataAudioClientOptions) {
    this.offer = options.offer;
    this.iceServers = options.iceServers?.filter(Boolean) ?? [RTC_DATA_AUDIO_DEFAULT_STUN];
    this.onBinaryMessage = options.onBinaryMessage;
    this.onControlMessage = options.onControlMessage;
    this.onClose = options.onClose;
  }

  get bufferedAmount(): number | null {
    return this.dataChannel?.bufferedAmount ?? null;
  }

  get isOpen(): boolean {
    return this.dataChannel?.readyState === 'open';
  }

  async connect(): Promise<void> {
    if (this.ready) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${normalizeWsUrl(this.offer.url)}?token=${encodeURIComponent(this.offer.token)}`);
      this.socket = socket;
      let settled = false;

      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('rtc-data-audio timed out before DataChannel opened'));
          this.close();
        }
      }, RTC_DATA_AUDIO_CONNECT_TIMEOUT_MS);

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        this.ready = true;
        window.clearTimeout(timer);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
        this.close();
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          return;
        }
        let message: SignalMessage;
        try {
          message = JSON.parse(event.data) as SignalMessage;
        } catch (error) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        void this.handleSignalMessage(message, settleResolve, settleReject).catch((error) => {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        });
      };
      socket.onerror = () => {
        settleReject(new Error('rtc-data-audio signaling WebSocket failed'));
      };
      socket.onclose = () => {
        if (!this.intentionallyClosed && !settled) {
          settleReject(new Error('rtc-data-audio signaling closed before ready'));
        } else if (!this.intentionallyClosed) {
          this.onClose?.();
        }
      };
    });
  }

  sendBinary(payload: ArrayBuffer | Uint8Array): boolean {
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== 'open') {
      return false;
    }
    channel.send(payload);
    return true;
  }

  sendJson(payload: Record<string, unknown>): boolean {
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== 'open') {
      return false;
    }
    channel.send(JSON.stringify(payload));
    return true;
  }

  close(): void {
    this.intentionallyClosed = true;
    this.ready = false;
    try {
      this.dataChannel?.close();
    } catch {
      // ignore
    }
    try {
      this.peer?.close();
    } catch {
      // ignore
    }
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.dataChannel = null;
    this.peer = null;
    this.socket = null;
  }

  private async handleSignalMessage(
    message: SignalMessage,
    onReady: () => void,
    onFailure: (error: Error) => void,
  ): Promise<void> {
    if (message.type === 'offer' && message.sdp) {
      await this.handleOffer(message.sdp, message.sdpType ?? 'offer', onReady, onFailure);
      return;
    }
    if (message.type === 'candidate' && message.candidate) {
      await this.peer?.addIceCandidate({ candidate: message.candidate, sdpMid: message.mid ?? '0' });
      return;
    }
    if (message.type === 'ready') {
      onReady();
    }
  }

  private async handleOffer(
    sdp: string,
    type: RTCSdpType,
    onReady: () => void,
    onFailure: (error: Error) => void,
  ): Promise<void> {
    if (!this.peer) {
      this.peer = this.createPeerConnection(onReady, onFailure);
    }
    await this.peer.setRemoteDescription({ type, sdp });
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    this.sendSignal({ type: 'answer', sdp: answer.sdp, sdpType: answer.type });
  }

  private createPeerConnection(onReady: () => void, onFailure: (error: Error) => void): RTCPeerConnection {
    const peer = new RTCPeerConnection({
      iceServers: this.iceServers.length > 0
        ? this.iceServers.map((urls) => ({ urls }))
        : [{ urls: RTC_DATA_AUDIO_DEFAULT_STUN }],
    });
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          type: 'candidate',
          candidate: event.candidate.candidate,
          mid: event.candidate.sdpMid ?? '0',
        });
      }
    };
    peer.ondatachannel = (event) => {
      this.bindDataChannel(event.channel, onReady);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        logger.warn('rtc-data-audio peer connection state changed', { state: peer.connectionState });
      }
      if (peer.connectionState === 'failed' && !this.intentionallyClosed) {
        onFailure(new Error('rtc-data-audio peer connection failed'));
      }
    };
    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === 'failed' && !this.intentionallyClosed) {
        onFailure(new Error('rtc-data-audio ICE connection failed'));
      }
    };
    return peer;
  }

  private bindDataChannel(channel: RTCDataChannel, onReady: () => void): void {
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      onReady();
    };
    channel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.onBinaryMessage?.(event.data);
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => this.onBinaryMessage?.(buffer));
      } else if (typeof event.data === 'string') {
        try {
          this.onControlMessage?.(JSON.parse(event.data));
        } catch (error) {
          logger.debug('Failed to decode rtc-data-audio control message', error);
        }
      }
    };
    channel.onclose = () => {
      if (!this.intentionallyClosed) {
        this.onClose?.();
      }
    };
    channel.onerror = () => {
      logger.warn('rtc-data-audio data channel error');
    };
  }

  private sendSignal(payload: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
