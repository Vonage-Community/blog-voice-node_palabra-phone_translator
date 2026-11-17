import { createServer } from 'node:http';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { Vonage } from '@vonage/server-sdk';
import { Chunker, FRAME_BYTES, mixFrames, ringbackFrame } from './audio.js';
import { PalabraStream } from './palabra.js';

const required = ['VONAGE_APPLICATION_ID', 'VONAGE_PRIVATE_KEY_PATH', 'VONAGE_NUMBER',
  'DESTINATION_NUMBER', 'PALABRA_CLIENT_ID', 'PALABRA_CLIENT_SECRET'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`);
  process.exit(1);
}

const {
  VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY_PATH, VONAGE_NUMBER, DESTINATION_NUMBER,
  PALABRA_CLIENT_ID, PALABRA_CLIENT_SECRET, CALLER_LANGUAGE = 'es', DESTINATION_LANGUAGE = 'en',
  PORT = 3000,
} = process.env;
const ORIGINAL_VOICE_GAIN = Number(process.env.ORIGINAL_VOICE_GAIN ?? 0.15);

// Keeps at most 30 seconds of translated audio waiting per listener, in case playback falls behind.
const MAX_QUEUED_FRAMES = 1_500;
const ENDED_STATUSES = ['completed', 'failed', 'rejected', 'busy', 'cancelled', 'timeout',
  'unanswered'];

const vonage = new Vonage({
  applicationId: VONAGE_APPLICATION_ID,
  privateKey: VONAGE_PRIVATE_KEY_PATH,
});

// Each call has two legs: the person who dialed in ("caller") and the person we dial
// ("destination").
const calls = new Map(); // inbound call UUID -> call
const callIdByLeg = new Map(); // either leg's UUID -> inbound call UUID

function createLeg(language) {
  return {
    language,
    uuid: null,
    socket: null,
    palabra: null,
    chunker: new Chunker(FRAME_BYTES), // this person's voice, in 20 ms frames
    // Palabra's audio chunks can be any length, so translated speech is re-cut into 20 ms frames.
    translatedChunker: new Chunker(FRAME_BYTES),
    translatedFrames: [], // translated speech waiting to be played to this person
    ringbackFrameNumber: 0,
  };
}

const app = express();
app.use(express.json());

// The tunnel's hostname arrives in the Host header, so the app never needs its public URL.
const baseUrl = (req) => `https://${req.get('host')}`;
const socketUrl = (req, role, callId) => `wss://${req.get('host')}/ws/${role}/${callId}`;

function connectToWebSocket(uri) {
  return {
    action: 'connect',
    endpoint: [{ type: 'websocket', uri, 'content-type': 'audio/l16;rate=24000' }],
  };
}

app.get('/webhooks/answer', async (req, res) => {
  const callId = req.query.uuid;
  console.log(`Call ${callId}: incoming from ${req.query.from}, dialing the destination`);
  const call = {
    id: callId,
    caller: createLeg(CALLER_LANGUAGE),
    destination: createLeg(DESTINATION_LANGUAGE),
    ended: false,
  };
  call.caller.uuid = callId;
  calls.set(callId, call);
  callIdByLeg.set(callId, callId);

  res.json([
    { action: 'talk', text: 'Please wait while we connect your call.' },
    connectToWebSocket(socketUrl(req, 'caller', callId)),
  ]);

  try {
    const { uuid } = await vonage.voice.createOutboundCall({
      to: [{ type: 'phone', number: DESTINATION_NUMBER }],
      from: { type: 'phone', number: VONAGE_NUMBER },
      answer_url: [`${baseUrl(req)}/webhooks/answer/destination/${callId}`],
      answer_method: 'GET',
      event_url: [`${baseUrl(req)}/webhooks/event`],
    });
    call.destination.uuid = uuid;
    callIdByLeg.set(uuid, callId);
  } catch (error) {
    console.error('Could not call the destination number:', error.message);
    endCall(callId);
  }
});

app.get('/webhooks/answer/destination/:callId', (req, res) => {
  res.json([connectToWebSocket(socketUrl(req, 'destination', req.params.callId))]);
});

app.post('/webhooks/event', (req, res) => {
  const { uuid, status } = req.body;
  console.log(`Call ${uuid}: ${status}`);
  if (ENDED_STATUSES.includes(status)) endCall(callIdByLeg.get(uuid));
  res.sendStatus(200);
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (socket, req) => {
  const [, prefix, role, callId] = new URL(req.url, 'http://localhost').pathname.split('/');
  const call = calls.get(callId);
  if (prefix !== 'ws' || !call || !['caller', 'destination'].includes(role)) {
    console.warn(`Rejected WebSocket for ${req.url}`);
    socket.close();
    return;
  }

  const leg = call[role];
  const otherLeg = role === 'caller' ? call.destination : call.caller;
  leg.socket = socket;
  console.log(`Call ${callId}: ${role} audio connected`);

  socket.on('message', (data, isBinary) => {
    // The first message is a JSON text event; everything after it is audio.
    if (!isBinary) return;

    for (const frame of leg.chunker.push(data)) {
      leg.palabra?.sendAudio(frame);

      // Until the other phone answers, the caller hears a ringback tone instead of silence.
      if (role === 'caller' && !otherLeg.socket) {
        socket.send(ringbackFrame(leg.ringbackFrameNumber++));
        continue;
      }

      // This leg's audio arrives every 20 ms, so it also sets the pace for the other leg:
      // the next frame of translated speech, with this speaker's own voice quietly underneath.
      // While translated speech plays, the original voice drops out so the translation stays clear.
      const translated = otherLeg.translatedFrames.shift();
      const gain = translated ? 0 : ORIGINAL_VOICE_GAIN;
      if (otherLeg.socket?.readyState === WebSocket.OPEN) {
        otherLeg.socket.send(mixFrames(translated, frame, gain));
      }
    }
  });

  socket.on('close', () => endCall(callId));

  if (call.caller.socket && call.destination.socket) startTranslation(call);
});

// One Palabra stream per direction. Each listener only hears the other person's translation.
async function startTranslation(call) {
  const streamFor = (speaker, listener, label) => new PalabraStream({
    clientId: PALABRA_CLIENT_ID,
    clientSecret: PALABRA_CLIENT_SECRET,
    sourceLanguage: speaker.language,
    targetLanguage: listener.language,
    label,
    onAudio: (audio) => {
      listener.translatedFrames.push(...listener.translatedChunker.push(audio));
      const excess = listener.translatedFrames.length - MAX_QUEUED_FRAMES;
      if (excess > 0) listener.translatedFrames.splice(0, excess);
    },
  });

  call.caller.palabra = streamFor(call.caller, call.destination, 'caller');
  call.destination.palabra = streamFor(call.destination, call.caller, 'destination');

  try {
    await Promise.all([call.caller.palabra.start(), call.destination.palabra.start()]);
    console.log(`Translating ${CALLER_LANGUAGE} <-> ${DESTINATION_LANGUAGE} for call ${call.id}`);
  } catch (error) {
    console.error('Could not start translation:', error.message);
    endCall(call.id);
  }
}

// Ending either leg ends the whole call, so nobody is left on a silent line.
function endCall(callId) {
  const call = calls.get(callId);
  if (!call || call.ended) return;
  call.ended = true;

  for (const leg of [call.caller, call.destination]) {
    leg.palabra?.stop();
    leg.socket?.close();
    if (leg.uuid) {
      callIdByLeg.delete(leg.uuid);
      vonage.voice.hangupCall(leg.uuid).catch(() => {
        // The leg has usually hung up already.
      });
    }
  }
  calls.delete(callId);
  console.log(`Call ${callId} ended`);
}

server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
