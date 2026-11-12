# Architecture and deployment scope

## Caller paths

1. **Sahibinden listing ID:** normalize the stated number and use an exact record lookup, followed by confirmation.
2. **Known consultant:** restrict candidates to the consultant's records. A consultant can have multiple listings, so this does not necessarily identify a property.
3. **Partial banner clues:** maintain explicit facts, rank candidates, and ask about distinguishing attributes. Accept that some callers cannot provide enough evidence.

The browser owns temporary dialogue state in this prototype. Portfolio search is deterministic application code over sample JSON. In the current React simulator, Qwen extracts facts while application code chooses a follow-up and tracks unanswered, unavailable and confirmed fields. The caller confirms the proposed listing. The older static client remains a historical implementation.

## Native packaging

`scripts/assistant.py` installs and supervises independent processes without a container. It compiles pinned llama.cpp and whisper.cpp source using the selected local backend. Python speech/search services and optional TTS use repository-local virtual environments. An asset manifest records model locations, pinned revisions, sizes and checksums.

The installer never downloads the entire VoxCPM2 language model: FreyaTTS needs only its AudioVAE weights. The local TTS adapter composes the published FreyaTTS components with explicitly downloaded weight files; upstream code is not edited. Runtime model hub access is disabled in the launcher.

`.local/` is disposable installation state, not source. Back up any future real office data separately; the current sample-data service is not an office database.

## What on-premises means here

The application can run its inference and search processes on the installation machine, using pre-downloaded assets. This demonstrates a local deployment approach. It is not evidence of a completed customer installation, an offline security assessment, a concurrent-call capacity target or high availability.

Real telephony, caller ID, secure durable callback storage, office access controls and delivery acknowledgments need separate implementation and validation before a live office pilot. No messages are sent by the current prototype.

## Current latency limits

Measure VAD endpoint delay, STT, extraction, search, follow-up generation, TTS and first playback separately. The earlier user-observed delay was up to 20 seconds on a 16 GB Mac; the installer does not establish an improved benchmark. CPU/Metal/MPS behavior is hardware-dependent. STT process startup and model loading per utterance, sequential LLM work, and complete-WAV TTS are optimization candidates.

## Evaluation scope

The initial report records 15 passing, 4 failing and 1 partial result across 20 text inputs. It bypasses speech recognition and predates the packaging changes. The checks in `tests/` cover repeat-question guards and installer behavior with mocks; a fresh end-to-end dialogue/audio evaluation is still required.

## November 12 browser checkpoint

The browser simulator is now a standalone `apps/web` React/TypeScript application. Gateways handle service calls; controllers manage speech capture, property dialogue, spoken output and the callback simulation. The Vite server proxies services on their existing local ports. The native backend installer remains compatible.

The accepted baseline is the easy path: a ten-digit listing ID, exact lookup, spoken confirmation, name, phone verification, consultant introduction, simulated callback and goodbye. One guided ID retry precedes consultant-name questions. Repeat/details/price questions preserve the current stage. The browser keeps listening for speech onset to interrupt audio. Full telephone integration, reliable barge-in under loudspeaker echo, consultant-only routing and ambiguous banner scenarios still need work and manual evaluation.

The repository's historical text checks do not validate the new React conversation. Recent conversation logs were manually evaluated on the development machine; no clean-install or production accuracy claim is made.
