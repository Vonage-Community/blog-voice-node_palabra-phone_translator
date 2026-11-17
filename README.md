# Real-Time Phone Translator With Vonage and Palabra AI

This Node.js app adds live speech-to-speech translation to an ordinary phone call. One person calls your Vonage number, the app dials a second person, and each of them hears the other in their own language.

```text
Caller (Spanish) ──WebSocket──►  server.js  ──► Palabra: es → en ──► Destination hears English
Caller hears Spanish ◄── Palabra: en → es ◄──  server.js  ◄──WebSocket── Destination (English)
```

How it works:

1. The [Voice API](https://developer.vonage.com/en/voice/voice-api/overview) calls the `/webhooks/answer` webhook. The app answers with an NCCO that streams the caller's audio to the server over a [WebSocket](https://developer.vonage.com/en/voice/voice-api/concepts/websockets), and it places an outbound call to the second person.
2. When the second person answers, their audio streams over a second WebSocket.
3. The server opens one [Palabra AI](https://palabra.ai) translation stream per direction. Each person hears the other's translated speech, with a quiet copy of the original voice underneath so the conversation keeps its timing.
4. When either person hangs up, the app ends the other leg and closes both translation streams.

Read the blog post: _coming soon_

## Prerequisites

- [Node.js](https://nodejs.org) 22 or newer
- [Vonage CLI](https://github.com/Vonage/vonage-cli) 3.3.1 or newer: `npm install -g @vonage/cli`
- A [Palabra AI](https://app.palabra.ai) account and an API key. Creating a key gives you a Client ID and a Client Secret.
- An [ngrok](https://ngrok.com) account and authtoken, for the tunnel
- Two phones: one to call your Vonage number, and one for the app to dial
- A [Vonage API account](https://developer.vonage.com/sign-up)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/Vonage-Community/vonage-palabra-phone-translator.git
cd vonage-palabra-phone-translator
npm install
cp .env.example .env
```

### 2. Authenticate the Vonage CLI

Find your API key and secret on the [Vonage dashboard](https://dashboard.vonage.com). This is the one step the CLI can't do for you. Then run:

```bash
vonage auth set --api-key=YOUR_API_KEY --api-secret=YOUR_API_SECRET
```

### 3. Create a Vonage application

```bash
vonage apps create "Phone Translator" --private-key-file=./private.key
```

This saves the private key as `private.key` in the project folder, which is where `.env` expects it. Copy the application ID from the output into `VONAGE_APPLICATION_ID` in `.env`.

Turn on Voice for the application. The `example.com` domain is a placeholder that the tunnel replaces in step 6:

```bash
vonage apps capabilities update YOUR_APP_ID voice --voice-answer-url=https://example.com/webhooks/answer --voice-answer-http=GET --voice-event-url=https://example.com/webhooks/event --voice-event-http=POST
```

### 4. Get a number and link it

```bash
vonage numbers search US
vonage numbers buy US YOUR_NUMBER
vonage apps numbers link YOUR_APP_ID YOUR_NUMBER
```

At the time of writing, `vonage numbers search` fails with `--features` (CLI 3.3.1), so the command above doesn't filter. The results show each number's features: pick one that lists VOICE.

Put the number in `VONAGE_NUMBER` in `.env`.

### 5. Fill in the rest of `.env`

| Variable | Value |
|---|---|
| `DESTINATION_NUMBER` | The phone the app dials, in E.164 format without the `+` (for example `14155550100`) |
| `PALABRA_CLIENT_ID` | The Client ID of your Palabra API key |
| `PALABRA_CLIENT_SECRET` | The Client Secret of your Palabra API key |
| `CALLER_LANGUAGE` | The language the caller speaks. Default `es` |
| `DESTINATION_LANGUAGE` | The language the destination speaks. Default `en` |
| `ORIGINAL_VOICE_GAIN` | Volume of the original voice under the translation, from `0` to `1`. Default `0.15` |
| `NGROK_AUTHTOKEN` | Your ngrok authtoken, used by the tunnel command |

See Palabra's [supported languages](https://docs.palabra.ai/docs/languages) for other language codes.

## Run

```bash
npm start
```

## Tunnel

In a second terminal, from the project folder:

```bash
vonage tunnel ngrok YOUR_APP_ID
```

The command opens an ngrok tunnel to port 3000 and points your application's webhooks at it. The app builds its WebSocket URLs from the incoming request, so there's no URL to copy into `.env`.

When you're done, press `q` to quit. That restores the `example.com` webhooks. Ctrl+C closes the tunnel without restoring them.

## Test

1. From the first phone, call your Vonage number. You hear "Please wait while we connect your call."
2. The second phone rings. Answer it.
3. Speak Spanish on the first phone. The second phone hears English a moment later, with the Spanish speaker's own voice quietly underneath.
4. Speak English on the second phone. The first phone hears Spanish.
5. Hang up either phone. The other call ends too.

The terminal running `npm start` logs what Palabra heard and what it translated, which helps when a translation comes out wrong.

## How the audio works

- Both Vonage WebSockets use `audio/l16;rate=24000`: 16-bit mono PCM at 24 kHz. Palabra's output is always 24 kHz mono, so the input uses 24 kHz too and nothing needs resampling. If the rates don't match, voices play back too fast, too slow, or at the wrong pitch.
- Vonage sends and expects 20 ms frames (960 bytes at 24 kHz). `audio.js` cuts Palabra's translated audio into frames of that size.
- Each person's incoming frames also set the timing for what the other person hears. Every 20 ms, the app sends the next frame of translated speech, or a quiet copy of the speaker's voice when no translation is playing.
- The app sends audio to Palabra in 320 ms chunks, the size Palabra recommends.

## Limitations

- **Translation takes a moment.** Each phrase is translated after the speaker pauses, so expect a short delay. On calls where a mistake matters, such as medical or legal calls, a professional interpreter is still the right choice.
- **The webhooks aren't authenticated.** Anyone who finds your tunnel URL could make the app dial `DESTINATION_NUMBER`. Quit the tunnel when you're not testing, and add [signed webhooks](https://developer.vonage.com/en/getting-started/concepts/webhooks#validating-signed-webhooks) before using this outside a demo.
- **Both legs are billed.** Vonage charges for the inbound and outbound call, and Palabra charges for two translation streams for as long as the call lasts.

## Cleanup

Quit the tunnel with `q` and stop the server. To remove what you created:

```bash
vonage apps numbers unlink YOUR_APP_ID YOUR_NUMBER
vonage numbers cancel US YOUR_NUMBER
vonage apps delete YOUR_APP_ID
```

## License

MIT. See [LICENSE](LICENSE).
