# UI validation

Verified with headless Google Chrome and Playwright, using the fixed light theme.

## Screen sizes

280×653, 320×568, 375×812, 390×844, 430×932, 768×1024, 1024×768, 1366×768, 1440×900, 1920×1080, 2560×1440, 844×390, 667×375, 320×400, 1024×280.

## Checks

90 layout scenarios passed: home, validation feedback, populated chat, expanded multiline composer with reconnect banner, invite sheet with QR, and a 100-member drawer. Checked horizontal bounds, visible content overflow, header/message/composer separation, and sheet vertical bounds. Populated chat used UI fixtures with long room IDs, messages, filenames and voice cards. Animations were disabled for stable geometry measurements.

Previously verified interaction checks: member/invite focus loops and focus restoration, Escape dismissal, 100-member header at narrow widths, viewport resizing, invite URL prefill, and no browser runtime errors. JavaScript syntax check passed. Desktop and mobile screenshots were visually reviewed.

These checks validate browser UI layout and interaction. Live room creation, joining, sidebar profile rendering and two-way text messages passed using two real browser tabs. Physical iOS/Safari keyboard behavior, voice recording and file transfer were not retested in this visual pass.

Light-only edition: all 15 screen sizes passed with the operating system emulated as dark and the old saved preference set to dark. No theme-switch controls remain; the interface stays light. JavaScript syntax check passed.
