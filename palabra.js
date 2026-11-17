import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Chunker, PALABRA_CHUNK_BYTES, SAMPLE_RATE } from './audio.js';

const STARTUP_TIMEOUT_MS = 15_000;
// Palabra rejects input_audio_data payloads under 1 KB of base64, about 768 bytes of audio.
const MIN_FLUSH_BYTES = 768;

// One Palabra speech-to-speech stream, translating a single caller in one direction.
export class PalabraStream {
  constructor({ clientId, clientSecret, sourceLanguage, targetLanguage, onAudio, label }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.onAudio = onAudio;
    this.label = label;
    this.chunker = new Chunker(PALABRA_CHUNK_BYTES);
    this.ready = false;
  }

  // Resolves once Palabra confirms the translation task is running.
  start() {
    // The random path segment lets Palabra spread connections across its servers.
    const url = `wss://streaming.palabra.ai/streaming-api/${randomUUID()}`
      + '/v1/speech-to-speech/stream';
    // Credentials go in headers rather than the URL, so they never show up in logs.
    this.ws = new WebSocket(url, {
      headers: { ClientID: this.clientId, ClientSecret: this.clientSecret },
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Palabra did not start in time')),
        STARTUP_TIMEOUT_MS,
      );

      this.ws.on('open', () => this.ws.send(JSON.stringify(this.taskSettings())));

      this.ws.on('message', (raw) => {
        let message;
        let data;
        try {
          message = JSON.parse(raw.toString());
          // Palabra sometimes sends `data` as a JSON string instead of an object.
          data = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
        } catch {
          return;
        }

        switch (message.message_type) {
          case 'task_status':
            if (data.command === 'set_task' && data.task_status === 'running' && !this.ready) {
              this.ready = true;
              clearTimeout(timer);
              resolve();
            }
            break;
          case 'output_audio_data':
            this.onAudio(Buffer.from(data.data, 'base64'));
            break;
          case 'validated_transcription':
          case 'translated_transcription': {
            const { language, text } = data.transcription;
            console.log(`[${this.label}] ${language}: ${text}`);
            break;
          }
          case 'warning':
            console.warn(`[${this.label}] Palabra warning: ${data.code}`);
            break;
          case 'error':
            console.error(`[${this.label}] Palabra error: ${data.code} ${data.desc ?? ''}`);
            if (!this.ready) {
              clearTimeout(timer);
              reject(new Error(data.code));
            }
            break;
        }
      });

      this.ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      this.ws.on('close', () => {
        if (this.ready) console.log(`[${this.label}] Palabra stream closed`);
        this.ready = false;
      });
    });
  }

  taskSettings() {
    return {
      message_type: 'set_task',
      data: {
        input_stream: {
          content_type: 'audio',
          source: { type: 'ws', format: 'pcm_s16le', sample_rate: SAMPLE_RATE, channels: 1 },
        },
        // Palabra's output is always 24 kHz mono, which matches the Vonage WebSocket.
        output_stream: { content_type: 'audio', target: { type: 'ws', format: 'pcm_s16le' } },
        pipeline: {
          transcription: {
            source_language: this.sourceLanguage,
            segment_confirmation_silence_threshold: 0.7,
            sentence_splitter: { enabled: true },
          },
          translations: [{ target_language: this.targetLanguage, speech_generation: {} }],
          // Transcripts are only logged. They show what Palabra heard when a translation is off.
          allowed_message_types: ['validated_transcription', 'translated_transcription'],
        },
      },
    };
  }

  // Vonage sends audio in real time, so 320 ms chunks reach Palabra at the pace it expects.
  sendAudio(frame) {
    if (!this.ready) return;
    for (const chunk of this.chunker.push(frame)) {
      this.send({ message_type: 'input_audio_data', data: { data: chunk.toString('base64') } });
    }
  }

  // Asks Palabra to finish the phrase in progress. Palabra closes the connection when it's done.
  stop() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const rest = this.chunker.flush();
    if (rest.length >= MIN_FLUSH_BYTES) {
      this.send({ message_type: 'input_audio_data', data: { data: rest.toString('base64') } });
    }
    this.send({ message_type: 'end_task', data: { force: false } });
    // Don't wait forever if Palabra never closes its side.
    setTimeout(() => this.ws.terminate(), 5_000).unref();
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
}
