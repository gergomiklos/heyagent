#!/usr/bin/env python3
import argparse
import sys


def main():
    parser = argparse.ArgumentParser(description="Synthesize speech with Kokoro TTS.")
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--lang", default="a")
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()

    try:
        import numpy as np
        import soundfile as sf
        from kokoro import KPipeline
    except Exception as error:
        print(
            "Kokoro dependencies are unavailable. Install them with: "
            "python3 -m pip install 'kokoro>=0.9.4' soundfile numpy",
            file=sys.stderr,
        )
        print(str(error), file=sys.stderr)
        return 2

    with open(args.text_file, "r", encoding="utf-8") as handle:
        text = handle.read().strip()

    if not text:
        print("No text provided for synthesis.", file=sys.stderr)
        return 1

    try:
        pipeline = KPipeline(lang_code=args.lang)
        chunks = []
        for _, _, audio in pipeline(text, voice=args.voice, speed=args.speed):
            chunks.append(audio)

        if not chunks:
            print("Kokoro produced no audio.", file=sys.stderr)
            return 1

        audio = np.concatenate(chunks)
        sf.write(args.output, audio, 24000)
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
