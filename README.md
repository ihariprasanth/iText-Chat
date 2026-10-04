# iText Chat

Anonymous **peer-to-peer** group chat, voice notes and file transfer in the browser.
No database, no accounts, no server storage. Close the tab and it's gone.

**Live:** https://ihariprasanth.github.io/iText-Chat/

## How it works

1. Enter **your name** and a **Room ID** → **Create room**.
2. Share the invite link / QR code, or tell people the Room ID.
3. They enter their name and the Room ID (or open the link) → **Join room**.
4. Everyone chats with names, avatars, voice notes, photos and files. Up to **100 people** per room.

The free PeerJS broker only introduces browsers to each other; it never sees content.
All messages and file bytes travel over encrypted WebRTC data channels (DTLS).

### Group architecture

A room is a **star**: the browser that holds the room ID is the hub and relays for everyone,
so each member keeps just one connection (a full mesh would need 1,225 connections for 50 people).

- **Host hand-over.** If the hub leaves, crashes or loses network, the next member in join
  order takes over the room ID automatically and everyone reconnects. The chat keeps going and each
  device keeps its own history. If the next people in line are asleep or gone, others step in
  within ~15 seconds. The broker guarantees only one of them wins.
- **Flow-controlled file fan-out.** The hub forwards files in 512 KB windows and only lets the
  sender run ahead once members have drained their buffers. A member too slow to keep up is
  skipped for that file (and told so) instead of stalling the whole group.
- **Dead member detection.** 10-second heartbeats; anyone silent for 35 seconds is removed.
- Receipts are batched and aggregated, so the sender sees *Delivered to 12 of 51 · Read by 9 of 51*,
  and blue ticks once everyone has read it.

Tested with a hub, a real guest and 50 independent bot peers: all 52 joined in ~20 s, every
message reached everyone, 2 MB and 3 MB files arrived byte-perfect at all 51 receivers, dead members
were dropped, and host hand-over reconnected all 51 members.

## Features

- **Names**: asked before joining; shown above messages with a colour-coded avatar;
  duplicates get a suffix (e.g. `Priya 2`)
- **Group**: member list with search and host badge, join/leave notices,
  "Amber and Fox are typing…", read receipts per message
- **Voice messages**: tap the mic, record with a live level meter, waveform playback with seek and 1× / 1.5× / 2×
- **Photos & videos**: inline previews, full-screen image viewer with download
- **Any file, any size**: chunked transfer with progress and cancel; drag & drop, paste, or attach
- **iOS-inspired “Liquid Glass” UI**: SF Pro typography, frosted glass toolbars and buttons, Telegram-style
  chat with a sidebar on desktop, wallpaper, grouped bubbles with tails and a floating composer
- **Light theme only**: consistent glass surfaces regardless of system appearance.
- **Works in the background**: a minimised window or another tab keeps the chat alive
  (Web Lock + worker heartbeat), with notifications, a sound, an unread counter and a favicon badge
- **Safe by default**: received non-media files are always handled as plain downloads

## Run

**GitHub Pages:** repo → Settings → Pages → Deploy from branch `main` / `(root)`.

**Locally** (any static server):

```bash
npx serve .
```

Open the printed URL in several browser tabs or on several devices.
Voice messages need HTTPS or `localhost` for microphone access.

## Limits

- The hub's upload carries every file once per member: a 10 MB photo to 50 people means ~500 MB
  uploaded by the hub, so big files to big groups take time.
- Messages sent before you joined aren't available (nothing is stored anywhere).
- Phones may pause a backgrounded browser after a while; the app reconnects when it resumes.
- Very strict corporate or mobile networks can block peer-to-peer; PeerJS's default public TURN relay helps but isn't guaranteed.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup and SVG icon set |
| `style.css` | Liquid Glass theme tokens (dark + light), layout, animations |
| `app.js` | Rooms, hub relay, host hand-over, messaging, file/voice transfer, background keep-alive |
| `icon.svg` | App icon / favicon |

## UI refresh

Professional desktop-inspired glass materials with a minimal Name / Room ID / Create / Join home. No traffic-light controls. `refined.css` contains the UI refinement layer.

The chat header and composer occupy normal layout space, so multiline drafts and reconnect banners do not cover messages. Member lists scroll independently; long room IDs and filenames fit narrow screens; invite sheets scroll on short screens. The visual viewport handles mobile keyboard height changes. Dialog keyboard focus stays inside the open panel and returns to the opener on dismissal.

See `UI-VALIDATION.md` for the responsive checks performed for this version.

### Premium visual pass

Custom vector app mark and flowing wallpaper, a more sculpted glass home card, icon-supported Create and Join actions, clearer field states, a desktop self-profile, refined message/file/voice cards, softer shadows, and restrained hover motion. Home still contains only Name, Room ID, Create and Join.

### Light-only edition

Dark styles, system appearance detection, saved theme preference handling and theme-switch controls have been removed. The interface always uses the light glass palette.
