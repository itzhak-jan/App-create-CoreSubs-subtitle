# Hebrew Font Setup

Place `Rubik-Regular.ttf` in this directory before building.

## How to obtain the font

Option A — Google Fonts (Recommended):
  https://fonts.google.com/specimen/Rubik
  Download → extract → copy Rubik-Regular.ttf here.

Option B — Assistant Hebrew (also excellent for Hebrew):
  https://fonts.google.com/specimen/Assistant
  File to copy: Assistant-Regular.ttf
  If you use this font, change "Rubik" → "Assistant" in:
    src/services/ExportService.ts → force_style FontName
    src/components/VideoPlayer/SubtitleOverlay.tsx → fontFamily style

## Why Rubik?

Rubik was designed by Philipp Hubert & Sebastian Fischer with a Hebrew
variant co-designed by Meir Sadan. It covers the full Hebrew Unicode block
(U+0590–U+05FF) including vowel points (nikud) and is optimised for screen
readability at small sizes.

## How it is used

At export time, ExportService.prepareFontDirectory() copies this file from
Android assets into the app's private cache directory. The path is then
passed to ffmpeg's subtitles filter via the `fontsdir` option, so libass
can load the font by its family name ("Rubik") without relying on any system
font — Android devices ship with no Hebrew-capable fonts by default.

The same font name is referenced in SubtitleOverlay.tsx for live playback display.
