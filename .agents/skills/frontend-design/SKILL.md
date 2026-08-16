---
name: frontend-design
description: Distinctive, high-craft visual design guidance for web applications and interfaces. Enforces domain-specific character, bold aesthetic direction, fluid proportional scaling across mobile and 4K/ultrawide displays, light/dark theme parity, multi-layered depth, and strict bans on generic AI design tropes. Use whenever building new UI pages, styling components, designing layouts, re-theming, or when the user says "make it look incredible/polished", "frontend design", "UI craft", "design direction", or when UI feels templated, generic, or poorly scaled.
---

# Frontend Design & Visual Craft

## Why this exists

AI-generated interfaces suffer from an unmistakable **"template syndrome"**: generic
cookie-cutter cards, uninspired typography, microscopic layouts on large monitors,
broken mobile responsiveness, and dark modes that look atmospheric while their light
modes look flat and washed out.

This skill acts as the **Creative Director**, steering implementation away from generic
AI habits and toward distinctive, bespoke visual identity, spatial harmony, and
meticulous craft.

---

## 1. The Creative Studio Mindset

Approach every frontend task as the lead designer at an elite creative studio known for
giving every project a visual identity that could never be mistaken for a generic template.

- **Ground in the Subject**: The domain's real-world vernacular—its instruments,
  materials, textures, and metaphors—must dictate the visual design. (A weather app
  should feel atmospheric and glanceable; a financial terminal should feel crisp,
  dense, and rock-solid; a creative tool should feel tactile and canvas-like).
- **Take One Deliberate Aesthetic Risk**: Make at least one opinionated, justifiable
  design departure: a bold typographic contrast, an asymmetrical layout anchor, a
  signature ambient atmosphere, a tactile paper texture, or an ultra-dense technical layout.
- **Authentic Copy & Data**: Never use robotic placeholder copy ("Elevate your
  experience with next-gen synergy"). Use realistic, domain-accurate content and
  labels throughout.

---

## 2. Multi-Display Spatial Architecture

AI interfaces routinely fail on two screen extremes: they blow out horizontally on mobile,
and render as tiny 900px islands surrounded by an empty void on 27"+ and 4K monitors.
Enforce the following spatial rules:

### A. Standard Viewport & Container Sizing (Anti-Stretching & Optimal Line Length)

Never allow content to stretch unconstrained across wide displays. Adhere to standard web container constraints:

1. **Standard Container Widths**:
   - **Standard Websites & Apps**: `max-width: 1200px` or `1280px` (e.g. `max-width: 80rem`), centered with `margin-inline: auto`.
   - **Data-Dense Dashboards & Complex Workspaces**: `max-width: 1440px` (e.g. `90rem`), centered with `margin-inline: auto`.
   - **Article / Text / Form Content**: `max-width: 680px` or `max-width: 65ch` to maintain comfortable 60–80 character line-length readability.
   ```css
   .container {
     width: 100%;
     max-width: 1280px; /* or 1440px for data-dense dashboards */
     margin-inline: auto;
     padding-inline: clamp(1rem, 3vw, 2.5rem);
   }
   ```
2. **On 27"+ / 4K / Ultrawide Displays ($\ge 1440\text{px}$)**:
   - The container **remains cleanly centered at standard max-width** with balanced left/right gutters.
   - Use fluid `clamp()` sizing for typography so text and key metrics remain crisp and readable from desktop viewing distance without breaking layout proportions.
   ```css
   --font-base: clamp(0.95rem, 0.9rem + 0.25vw, 1.1rem);
   --font-hero: clamp(3rem, 6vw, 4.5rem);
   ```

### B. Mobile & Tablet Responsiveness ($\le 768\text{px}$)

1. **Strict Zero-Blowout Constraint**:
   Ensure `box-sizing: border-box` on all elements. Prevent horizontal scroll bleed
   with `overflow-x: clip` on root containers and `max-width: 100%` on all media/cards.
2. **Touch-First Affordances**:
   All interactive tap targets (buttons, pills, list items) MUST be $\ge 44\text{px} \times 44\text{px}$.
3. **Mobile Layout Adaptations**:
   - Convert desktop side drawers into native-feeling slide-up bottom sheets.
   - Convert wide multi-column grids into horizontally swipeable touch carousels with hidden scrollbars:
     ```css
     .touch-carousel {
       display: flex;
       overflow-x: auto;
       scroll-snap-type: x mandatory;
       -webkit-overflow-scrolling: touch;
       scrollbar-width: none;
     }
     .touch-carousel::-webkit-scrollbar { display: none; }
     ```

---

## 3. Dark & Light Theme Parity

A common failure is building a visually stunning dark mode with glowing accents, while
the light mode is an afterthought that looks flat, washed out, and unstyled.

### Light Mode Craft Rules:
- **Never Pure White on Pure White**: Layer tinted background canvases (`#f1f5f9` or warm neutral `#f8fafc`) behind crisp white cards (`#ffffff`) to create immediate visual separation.
- **Diffuse Multi-Layer Shadows**: Use multi-stop soft shadows for realistic elevation:
  ```css
  --shadow-card-light: 0 1px 3px 0 rgba(0, 0, 0, 0.04), 0 8px 24px -4px rgba(0, 0, 0, 0.07);
  ```
- **Crisp Hairline Boundaries**: Use subtle borders (`rgba(15, 23, 42, 0.08)`) so card edges stay defined even in bright sunlight.
- **Readable Contrast**: Use deep slate/charcoal (`#0f172a`, `#1e293b`) for primary text rather than harsh pure black (`#000000`) or faint washed-out grays.

### Dark Mode Craft Rules:
- **Atmospheric Depth over Flat Black**: Use deep obsidian, slate, or charcoal tones (`#0b0f19`, `#111827`, `#0f172a`) rather than harsh, flat `#000000`.
- **Match Material to Domain**:
  - *Solid / Clean Surfaces*: Distinct layered backgrounds (`--bg-surface: #1e293b`, `--bg-card: #243048`) with subtle 1px border outlines.
  - *Atmospheric / Glass*: Translucent surfaces (`rgba(255, 255, 255, 0.08)` with `backdrop-filter: blur(20px)`) when appropriate for fluid, ambient products (e.g. weather, media).
  - *High-Density Terminal*: Monospace tables, sharp borders, high-contrast indicators for technical tools.
- **Soft Specular Lighting**: When adding depth, use delicate inner highlights (`inset 0 1px 0 rgba(255, 255, 255, 0.1)`) rather than loud glowing outlines.

---

## 4. Typography & Visual Hierarchy

Typography carries the entire personality of the interface:

1. **Intentional Pairings**:
   Pair a distinctive display font (e.g. `Plus Jakarta Sans`, `Cabinet Grotesk`, `Newsreader`, `Space Grotesk`) with a highly legible body face (`Inter`, `Geist`, `-apple-system`).
2. **Numeric & Data Typography**:
   For numbers, stats, and timestamps, always enable tabular figures (`font-variant-numeric: tabular-nums`) so numbers don't jump horizontally as values update.
3. **Tracking & Optical Weight**:
   - Tighten letter-spacing on large display titles (`letter-spacing: -0.03em`).
   - Open letter-spacing on small uppercase micro-labels (`letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.75rem`).

---

---

## 5. Purposeful Micro-Interactions & Motion

Animation should inform and delight, never distract:

1. **Subtle Affordances**:
   Every interactive element must have active hover, focus-visible, and press states with snappy transitions (`transition: all 180ms cubic-bezier(0.16, 1, 0.3, 1)`).
2. **Living Data**:
   Gauges, progress bars, and charts should animate into view on initial load.
3. **No Over-Animation**:
   Avoid endless looping particle effects, spinning backgrounds, or bouncing badges that scream "AI demo."

---

## 6. State Transitions, Skeletons & Resilient States

AI agents routinely build only the "happy path" (fully loaded state), leaving apps to flash white, jump abruptly, or show blank voids while fetching data. Enforce complete state handling for every dynamic surface:

### A. Ghost Skeletons & Shimmer Loaders
- **Zero Layout Shift (CLS)**: Skeleton placeholders MUST match the exact dimensions, aspect ratios, and grid structure of the final loaded cards, charts, and lists. Content must never jump or pop when data resolves.
- **Subtle Pulse/Shimmer**: Use gentle, low-contrast opacity pulses rather than harsh flashing bars:
  ```css
  .skeleton {
    background: var(--bg-surface-subtle, rgba(255, 255, 255, 0.08));
    border-radius: var(--radius-md, 8px);
    animation: skeleton-pulse 1.6s ease-in-out infinite;
  }
  @keyframes skeleton-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.85; }
  }
  ```

### B. Micro-Loading & Async Feedback
- **Buttons in Flight**: Action buttons performing async requests MUST show an inline micro-spinner, disable user input, and preserve original button width to prevent layout jitter.
- **Search & Filter Inputs**: Inputs performing debounced network queries MUST show a subtle inline spinner or pulsing indicator inside the input slot.

### C. Graceful Empty & First-Run States
- Never leave an uninitialized screen blank or with raw unstyled text (`<p>No results</p>`).
- Provide an intentional empty state: a themed icon, a clear description, and an actionable next step (e.g. *"No tracked cities yet — search for a location above to bookmark it"*).

### D. Error Resilience with Inline Retry
- Never allow a failed network call to crash the component hierarchy or display raw stack traces.
- Render a non-blocking error badge or card with a clean human explanation and an immediate **"Retry"** action button.

### E. Smooth Content Cross-Fade
- When transitioning from loading $\rightarrow$ loaded, apply a subtle cross-fade (`transition: opacity 180ms ease-out`) so content fades in smoothly instead of snapping into view.

---

## 7. Strict Anti-AI Design Tropes (Forbidden Patterns)

Unless explicitly requested by the user, **NEVER** use these clichés:

- ❌ **No Fake Status Pips / Decorative "Ready" Badges**: Never add decorative green/colored dots with static text like "● Ready", "● Live", "● Operational", "● Active", "● Online", or "● v1.0" in headers, cards, or hero sections unless the application's explicit primary function is a real-time server infrastructure health monitor. Decorative status pips are useless clutter that scream "AI template".
- ❌ **No Emojis as UI Icons**: Never use raw unicode emojis (`🔍`, `⭐`, `☀️`, `⚙️`, `🗑️`, `🔥`, `📊`) as interface icons, button graphics, or status indicators. Emojis render inconsistently across operating systems (iOS vs Android vs Windows vs Linux), clash with theme color palettes, and look amateur. Always use crisp, scalable vector SVG icons (Lucide, Heroicons, Radix, or custom inline SVGs) that inherit theme colors via `currentColor`.
- ❌ **No Purple/Violet on Dark**: The cliché purple-on-black gradient or violet-glowing border.
- ❌ **No Fake Numbered Markers**: Numbering items `01 / 02 / 03` when they are not an ordered chronological sequence.
- ❌ **No Icon-Stuffed Bento Clutter**: Random bento box grids crammed with disconnected icons.
- ❌ **No Pulsing Biscuit Badges**: Small pill badges with animated glowing dots floating over headlines for no reason.
- ❌ **No Gradient Keyword Fills**: Rainbow/gradient text fills across random words in a headline.
- ❌ **No Robotic Placeholder Copy**: Replace generic corporate text with crisp, realistic domain copy.
