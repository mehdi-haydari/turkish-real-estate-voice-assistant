# Third-party components

This repository contains the application and installation code, not model weights or vendored inference engines. The installer retrieves the assets from upstream. Their respective licenses continue to apply.

| Component | Upstream |
|---|---|
| llama.cpp | https://github.com/ggml-org/llama.cpp — MIT |
| whisper.cpp | https://github.com/ggml-org/whisper.cpp — MIT |
| Whisper model weights | https://huggingface.co/ggerganov/whisper.cpp ; original https://github.com/openai/whisper |
| Qwen3-4B-Instruct-2507 quantization | https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF ; original https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507 |
| Silero VAD | https://github.com/snakers4/silero-vad — MIT |
| FreyaTTS-small | https://github.com/freyavoiceai/FreyaTTS ; https://huggingface.co/freyavoice/freya-tts — Apache-2.0 |
| AudioVAE2 / VoxCPM2 | https://huggingface.co/openbmb/VoxCPM2 ; https://github.com/OpenBMB/VoxCPM |

`services/tts/local_model.py` adapts the component-loading sequence of FreyaTTS to pre-downloaded local files. FreyaTTS copyright belongs to its authors. Its Apache-2.0 license is included in `licenses/FreyaTTS-Apache-2.0.txt`. No upstream model or training contribution is claimed by this application.

The installer pins direct Python requirements and source/model revisions. Python's transitive dependencies are resolved by pip and are not a complete cross-platform lockfile. A complete audited dependency/SBOM process is future deployment work.
