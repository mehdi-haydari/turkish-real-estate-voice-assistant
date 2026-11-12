# Browser call simulator

React + TypeScript frontend for the local voice assistant. Run the Python/LLM services with the root native launcher first, then:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173 and select **Start listening**. Voice replies require the optional FreyaTTS service. The development server proxies STT/WebSocket, LLM, portfolio and TTS requests to the loopback services.

The caller can interrupt spoken replies. Browser echo cancellation is requested, but loudspeaker echo can still cause false interruptions. The chat and **Copy chat** include stage timings and in-memory simulated callback details. **Stop** cancels playback; a completed goodbye stops listening, and **Start new call** resets dialogue state.

Service targets can be changed through `STT_SERVICE_URL`, `LLM_SERVICE_URL`, `PORTFOLIO_SERVICE_URL` and `TTS_SERVICE_URL`. Keep personal `.env` files out of Git.

`npm run build` compiles the frontend. This development simulator has not been validated as a production telephone service.
