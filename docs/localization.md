# Interface localization

The shared React module accepts `locale` in its mount options. The authenticated
host supplies the resolved profile language (personal preference, instance
preference, then English); never select a user from browser-supplied IDs. The
optional `setLocale(locale)` method changes an existing mount without remounting
its screens, losing drafts or changing the host document. Each factory invocation
owns its locale subscription, auth state, navigation and temporary storage.
Supported languages are English, Russian, Spanish, German and French. Regional
tags normalize to their supported base language; unsupported values use English.
The standalone product retains English by default when there is no host locale.

Use `usePointerTranslations()` for text, including generated labels, loading,
empty, failure, title and accessibility messages. Catalogues are plain text in
`apps/web/src/messages`; `{name}` arguments are interpolated as text and escaped
by React. They are never HTML and do not implement ICU. Use complete sentences
and count-neutral labels for quantities; use `usePointerFormats()` for localized
numbers, percentages and dates. Preserve provider/model identifiers, user content,
API values, protocol names and brands. Provider diagnostics remain technical data;
interface failures use stable localized messages.

Add a language to `src/lib/locale.ts`, `src/lib/i18n.ts`, the catalogue validator
and all catalogues together. Keep keys and arguments identical. The embedded
build checks catalogue parity and rejects new unlocalized interface literals.
The small reviewed literal inventory contains brands, protocol/unit names and
example identifiers; do not grow it to hide untranslated prose. Module navigation
labels are checked against the catalogues and translated at render time.

Run `pnpm --filter @pointer/web i18n:check`, `pnpm --filter @pointer/web test:i18n`,
its typecheck and `build:embed`. The negative guard fixtures cover missing keys,
placeholder drift, untranslated accessibility text, templates, loading-table
columns and misplaced client directives. Keep API filter and route values
unchanged when translating their visible labels. Consolidated Overview and
Test model routes, provider refresh warnings and instance key dialogs follow
the same localization contract as the standalone screens.
`pnpm --dir apps/web exec playwright test --config playwright.embed.config.ts`
exercises real shared-React rendering, independent mounts, regional fallback and
draft preservation during locale changes. These fixture checks do not establish
installed host admission, credential isolation, signed updates or recovery.
