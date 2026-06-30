/** introduction animation for Tegami.js */

const changelogs = [
  {
    title: "Fix npm provenance",
    body: "Release notes explain the user-facing change.",
  },
  {
    title: "Add Cargo support",
    body: "Rust crates join the same publishing flow.",
  },
  {
    title: "Improve PR comments",
    body: "Every change is captured before shipping.",
  },
];

const commits = [
  "feat: add cargo provider",
  "fix: keep peer ranges aligned",
  "docs: explain release plans",
];

const dependencies = [
  ['"@acme/ui"', '"1.8.0"'],
  ['"@acme/core"', '"3.2.1"'],
  ['"@acme/cli"', '"0.12.4"'],
];

export default function Page() {
  return (
    <main className="tegami-animation" aria-label="Tegami introduction animation">
      <section className="stage">
        <div className="grain" />
        <div className="intro-copy">
          <p>Introducing Tegami.js</p>
          <h1>A tool to manage changelogs, versioning, and publishing.</h1>
        </div>
        <div className="phase-copy record-copy">
          <p>Record</p>
          <h1>Record Every Change.</h1>
        </div>
        <div className="phase-copy prepare-copy">
          <p>Prepare</p>
          <div
            className="prepare-heading"
            aria-label="Bump Version, Update Dependencies, Be Ready for Publishing"
          >
            <h1>Bump Version</h1>
            <h1>Update Dependencies</h1>
            <h1>Be Ready for Publishing</h1>
          </div>
        </div>
        <div className="phase-copy publish-copy">
          <p>Publish</p>
          <h1>Send Packages to Any Registry.</h1>
        </div>

        <div className="record-scene">
          <div className="changelog-stack" aria-hidden="true">
            {changelogs.map((item, index) => (
              <article
                className="change-note"
                key={item.title}
                style={{ "--i": index } as React.CSSProperties}
              >
                <span>### {item.title}</span>
                <p>{item.body}</p>
              </article>
            ))}
          </div>

          <div className="commit-lane" aria-hidden="true">
            <div className="terminal">
              <span className="terminal-dot" />
              <span className="terminal-dot" />
              <span className="terminal-dot" />
            </div>
            {commits.map((commit, index) => (
              <div className="commit" key={commit} style={{ "--i": index } as React.CSSProperties}>
                <span />
                {commit}
              </div>
            ))}
          </div>
        </div>

        <div className="package-editor" aria-hidden="true">
          <div className="editor-bar">
            <span />
            <strong>package.json</strong>
          </div>
          <pre>
            <code>
              {"{\n"}
              {'  "name": "@acme/ui",\n'}
              {'  "version": '}
              <span className="old-version">"1.7.4"</span>
              <span className="new-version updated-token">"1.8.0"</span>
              {",\n"}
              {'  "dependencies": {\n'}
              {dependencies.map(([name, version]) => (
                <span className="dependency-line" key={name}>
                  {"    "}
                  {name}: <span className="updated-token">{version}</span>
                  {"\n"}
                </span>
              ))}
              {"  }\n"}
              {"}"}
            </code>
          </pre>
        </div>

        <div className="envelope-wrap" aria-hidden="true">
          <div className="envelope">
            <div className="letter-card">
              <span />
              <span />
              <span />
            </div>
            <div className="envelope-shell">
              <div className="envelope-back" />
              <div className="envelope-left-fold" />
              <div className="envelope-right-fold" />
              <div className="envelope-bottom-fold" />
              <div className="envelope-flap" />
              <div className="wax-seal">手</div>
            </div>
          </div>
        </div>

        <div className="registry-strip" aria-hidden="true">
          <div className="registry-logo npm-logo">npm</div>
          <div className="registry-logo rust-logo">
            <svg viewBox="0 0 100 100" role="img" aria-label="Rust">
              <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="7">
                <circle cx="50" cy="50" r="30" />
                <path d="M50 8v12M50 80v12M8 50h12M80 50h12M20 20l9 9M71 71l9 9M80 20l-9 9M29 71l-9 9" />
              </g>
              <text
                x="50"
                y="61"
                fill="currentColor"
                fontFamily="JetBrains Mono, ui-monospace, monospace"
                fontSize="30"
                fontWeight="900"
                textAnchor="middle"
              >
                R
              </text>
            </svg>
            <span>Cargo</span>
          </div>
        </div>

        <div className="final-card">
          <img src="/logo.png" alt="" />
          <h2>Try Tegami.js</h2>
          <p>https://tegami.fuma-nama.dev</p>
          <a href="https://tegami.fuma-nama.dev">npm i tegami</a>
        </div>
      </section>

      <style>{`
        html,
        body {
          margin: 0;
          overflow: hidden;
          background: #f7f5ef;
        }

        .tegami-animation {
          width: 1920px;
          height: 1080px;
          overflow: hidden;
          background: #f7f5ef;
          color: #111;
          display: grid;
          place-items: center;
          font-family:
            Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
            "Segoe UI", sans-serif;
        }

        .stage {
          --duration: 28s;
          position: relative;
          isolation: isolate;
          width: 1920px;
          height: 1080px;
          aspect-ratio: 16 / 9;
          overflow: hidden;
          background: #f7f5ef;
        }

        .grain {
          position: absolute;
          inset: 0;
          z-index: 0;
          opacity: 0.55;
          pointer-events: none;
          background-image:
            linear-gradient(rgba(17, 17, 17, 0.045) 1px, transparent 1px),
            linear-gradient(90deg, rgba(17, 17, 17, 0.045) 1px, transparent 1px);
          background-size: 64px 64px;
        }

        .intro-copy {
          position: absolute;
          inset: 0;
          z-index: 6;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 42px;
          padding: 0 120px;
          text-align: center;
          opacity: 0;
          transform: translateY(22px);
          animation: introGroup var(--duration) linear infinite;
        }

        .intro-copy p {
          margin: 0;
          color: #111;
          font-size: 120px;
          line-height: 0.95;
          font-weight: 500;
          letter-spacing: 0;
          white-space: nowrap;
          transform: scale(1);
          transform-origin: center;
          animation: introTitle var(--duration) cubic-bezier(0.19, 1, 0.22, 1) infinite;
        }

        .intro-copy h1 {
          margin: 0;
          max-width: 13ch;
          color: #111;
          font-size: 72px;
          line-height: 0.92;
          font-weight: 600;
          letter-spacing: 0;
          text-wrap: balance;
          transform: scale(0.86);
          transform-origin: center;
          animation: introDescription var(--duration) cubic-bezier(0.19, 1, 0.22, 1)
            infinite;
        }

        .phase-copy {
          position: absolute;
          left: 120px;
          top: 82px;
          z-index: 5;
          width: 900px;
          opacity: 0;
          transform: translateY(22px);
        }

        .phase-copy p {
          margin: 0 0 18px;
          color: #111;
          font-size: 22px;
          font-weight: 800;
          letter-spacing: 0;
          text-transform: uppercase;
        }

        .phase-copy h1 {
          margin: 0;
          max-width: 11ch;
          color: #111;
          font-size: 114px;
          line-height: 0.94;
          letter-spacing: 0;
          text-wrap: balance;
        }

        .record-copy {
          animation: recordText var(--duration) linear infinite;
        }

        .prepare-copy {
          top: 96px;
          opacity: 1;
          transform: none;
        }

        .prepare-copy p {
          opacity: 0;
          animation: prepareLabel var(--duration) linear infinite;
        }

        .prepare-heading {
          position: relative;
          width: 780px;
          min-height: 380px;
        }

        .prepare-heading h1 {
          position: absolute;
          inset: 0 auto auto 0;
          margin: 0;
          max-width: 10ch;
          font-size: 88px;
          opacity: 0;
          transform: translateY(22px);
          animation: prepareHeadingOne var(--duration) linear infinite;
        }

        .prepare-heading h1:nth-child(2) {
          animation-name: prepareHeadingTwo;
        }

        .prepare-heading h1:nth-child(3) {
          animation-name: prepareHeadingThree;
        }

        .publish-copy {
          top: 96px;
          animation: publishText var(--duration) linear infinite;
        }

        .record-scene {
          position: absolute;
          inset: 0;
          z-index: 2;
          animation: recordScene var(--duration) linear infinite;
        }

        .changelog-stack,
        .commit-lane {
          position: absolute;
          top: 410px;
        }

        .changelog-stack {
          left: 96px;
          top: 430px;
          width: 760px;
          height: 430px;
        }

        .change-note {
          position: absolute;
          inset: 0;
          height: 330px;
          padding: 46px;
          border: 2px solid #111;
          border-radius: 8px;
          background: #fff;
          color: #111;
          opacity: 0;
          transform: translateX(-38px) rotate(calc((var(--i) - 1) * -5deg));
          animation: noteIn var(--duration) cubic-bezier(0.19, 1, 0.22, 1) infinite;
        }

        .change-note span {
          display: block;
          margin-bottom: 0.8rem;
          font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco,
            Consolas, "Liberation Mono", monospace;
          font-size: 28px;
          font-weight: 800;
        }

        .change-note p {
          margin: 0;
          color: #333;
          font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco,
            Consolas, "Liberation Mono", monospace;
          font-size: 22px;
          line-height: 1.55;
        }

        .commit-lane {
          right: 96px;
          top: 410px;
          width: 720px;
          min-height: 330px;
          padding: 32px;
          border: 2px solid #111;
          border-radius: 8px;
          background: #fff;
        }

        .terminal {
          display: flex;
          gap: 0.38rem;
          margin-bottom: 22px;
        }

        .terminal-dot,
        .editor-bar span {
          width: 14px;
          height: 14px;
          border-radius: 999px;
          background: #111;
        }

        .commit {
          display: flex;
          align-items: center;
          gap: 16px;
          min-height: 68px;
          margin-top: 18px;
          padding: 0 24px;
          border-radius: 6px;
          border: 1px solid #111;
          background: #f7f5ef;
          color: #111;
          font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco,
            Consolas, "Liberation Mono", monospace;
          font-size: 23px;
          opacity: 0;
          transform: translateX(34px);
          animation: commitIn var(--duration) cubic-bezier(0.19, 1, 0.22, 1) infinite;
        }

        .commit span {
          width: 14px;
          height: 14px;
          border-radius: 999px;
          background: #111;
          flex: 0 0 auto;
        }

        .envelope-wrap {
          position: absolute;
          left: 300px;
          top: 610px;
          z-index: 4;
          width: 700px;
          height: 484px;
          transform: translateY(72px) scale(0.82);
          opacity: 0;
          animation: envelopeJourney var(--duration) cubic-bezier(0.65, 0, 0.35, 1) infinite;
        }

        .envelope {
          position: relative;
          width: 100%;
          height: 100%;
        }

        .envelope-shell {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 392px;
          border: 3px solid #111;
          border-radius: 10px;
          overflow: hidden;
          background: #fff;
        }

        .envelope-back {
          position: absolute;
          inset: 0;
          background:
            linear-gradient(31deg, transparent 49.6%, #111 49.8%, #111 50.2%, transparent 50.4%),
            linear-gradient(149deg, transparent 49.6%, #111 49.8%, #111 50.2%, transparent 50.4%),
            #fff;
        }

        .letter-card {
          position: absolute;
          left: 72px;
          right: 72px;
          top: 0;
          height: 320px;
          padding: 58px 64px;
          border-radius: 6px;
          border: 3px solid #111;
          background: #fff;
          transform-origin: bottom;
          animation: letterSlide var(--duration) cubic-bezier(0.65, 0, 0.35, 1) infinite;
        }

        .letter-card span {
          display: block;
          height: 14px;
          margin-bottom: 24px;
          border-radius: 999px;
          background: #111;
        }

        .letter-card span:nth-child(2) {
          width: 74%;
        }

        .letter-card span:nth-child(3) {
          width: 52%;
        }

        .envelope-left-fold,
        .envelope-right-fold,
        .envelope-bottom-fold,
        .envelope-flap {
          position: absolute;
          inset: 0;
          background: #fff;
        }

        .envelope-left-fold {
          clip-path: polygon(0 0, 50% 50%, 0 100%);
          background: #f7f5ef;
        }

        .envelope-right-fold {
          clip-path: polygon(100% 0, 50% 50%, 100% 100%);
          background: #f7f5ef;
        }

        .envelope-bottom-fold {
          clip-path: polygon(0 100%, 50% 44%, 100% 100%);
          background: #fff;
        }

        .envelope-flap {
          clip-path: polygon(0 0, 100% 0, 50% 62%);
          background: #fff;
          transform-origin: top;
          animation: sealFlap var(--duration) cubic-bezier(0.65, 0, 0.35, 1) infinite;
        }

        .envelope-flap::after,
        .envelope-bottom-fold::after {
          position: absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          content: "";
          background:
            linear-gradient(31deg, transparent 49.4%, #111 49.8%, #111 50.2%, transparent 50.6%),
            linear-gradient(149deg, transparent 49.4%, #111 49.8%, #111 50.2%, transparent 50.6%);
        }

        .wax-seal {
          position: absolute;
          left: 50%;
          top: 54%;
          display: grid;
          width: 88px;
          aspect-ratio: 1;
          place-items: center;
          border-radius: 999px;
          border: 3px solid #111;
          background: #111;
          color: #fff;
          font-size: 38px;
          font-weight: 900;
          transform: translate(-50%, -50%) scale(0);
          animation: waxSeal var(--duration) cubic-bezier(0.19, 1, 0.22, 1) infinite;
        }

        .package-editor {
          position: absolute;
          right: 104px;
          top: 48%;
          z-index: 3;
          width: 680px;
          border: 2px solid #111;
          border-radius: 8px;
          overflow: hidden;
          background: #fff;
          opacity: 0;
          transform: translate(24px, -44%) scale(0.96);
          animation: editorScene var(--duration) cubic-bezier(0.19, 1, 0.22, 1) infinite;
        }

        .editor-bar {
          display: flex;
          align-items: center;
          gap: 0.9rem;
          height: 58px;
          padding: 0 22px;
          border-bottom: 2px solid #111;
          color: #111;
          font-size: 17px;
        }

        .package-editor pre {
          margin: 0;
          padding: 30px;
          color: #111;
          font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco,
            Consolas, "Liberation Mono", monospace;
          font-size: 22px;
          line-height: 1.65;
          white-space: pre-wrap;
        }

        .old-version,
        .new-version,
        .dependency-line span {
          display: inline-block;
          color: #111;
        }

        .updated-token {
          position: relative;
          z-index: 0;
          padding: 0 0.22em;
          margin: 0 -0.22em;
          border-radius: 4px;
        }

        .updated-token::before {
          position: absolute;
          inset: 0.12em -0.1em 0.08em;
          z-index: -1;
          content: "";
          border: 2px solid #111;
          border-radius: 5px;
          background: #fff;
          opacity: 0;
          transform: scaleX(0.72);
          transform-origin: left center;
          animation: fieldHighlight var(--duration) cubic-bezier(0.19, 1, 0.22, 1)
            infinite;
        }

        .old-version {
          animation: oldVersion var(--duration) linear infinite;
        }

        .new-version {
          margin-left: -4.2rem;
          color: #111;
          opacity: 0;
          animation:
            newVersion var(--duration) linear infinite,
            tokenPop var(--duration) cubic-bezier(0.19, 1, 0.22, 1) infinite;
        }

        .dependency-line {
          display: inline;
          opacity: 0.36;
          animation: dependencyUpdate var(--duration) linear infinite;
        }

        .dependency-line .updated-token {
          animation: tokenPop var(--duration) cubic-bezier(0.19, 1, 0.22, 1) infinite;
        }

        .dependency-line:nth-of-type(1) {
          animation-delay: 0.2s;
        }

        .dependency-line:nth-of-type(2) {
          animation-delay: 0.45s;
        }

        .dependency-line:nth-of-type(3) {
          animation-delay: 0.7s;
        }

        .dependency-line:nth-of-type(1) .updated-token,
        .dependency-line:nth-of-type(1) .updated-token::before {
          animation-delay: 0.1s;
        }

        .dependency-line:nth-of-type(2) .updated-token,
        .dependency-line:nth-of-type(2) .updated-token::before {
          animation-delay: 0.35s;
        }

        .dependency-line:nth-of-type(3) .updated-token,
        .dependency-line:nth-of-type(3) .updated-token::before {
          animation-delay: 0.6s;
        }

        .registry-strip {
          position: absolute;
          left: 50%;
          bottom: 92px;
          z-index: 4;
          display: flex;
          gap: 36px;
          align-items: center;
          transform: translateX(-50%);
          opacity: 0;
          animation: registryScene var(--duration) linear infinite;
        }

        .registry-logo {
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 178px;
          height: 96px;
          border: 2px solid #111;
          border-radius: 8px;
          background: #fff;
          color: #111;
          font-weight: 900;
        }

        .npm-logo {
          background: #111;
          color: #fff;
          font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco,
            Consolas, "Liberation Mono", monospace;
          font-size: 42px;
        }

        .rust-logo {
          min-width: 196px;
          gap: 14px;
          padding: 0 22px;
          background: #fff;
          color: #111;
        }

        .rust-logo svg {
          width: 58px;
          height: 58px;
          display: block;
        }

        .rust-logo span {
          font-size: 32px;
          line-height: 1;
        }

        .final-card {
          position: absolute;
          inset: 0;
          z-index: 7;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transform: scale(0.96);
          animation: finalScene var(--duration) cubic-bezier(0.19, 1, 0.22, 1) infinite;
          text-align: center;
        }

        .final-card img {
          width: 132px;
          height: 132px;
          margin-bottom: 36px;
          object-fit: contain;
        }

        .final-card h2 {
          margin: 0;
          color: #111;
          font-size: 128px;
          line-height: 0.9;
          letter-spacing: 0;
        }

        .final-card a {
          margin-top: 28px;
          padding: 18px 28px;
          border: 2px solid #111;
          border-radius: 8px;
          background: #111;
          color: #fff;
          font-size: 28px;
          font-weight: 800;
          text-decoration: none;
          opacity: 0;
          font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco,
            Consolas, "Liberation Mono", monospace;
          animation: finalLink var(--duration) linear infinite;
        }

        .final-card p {
          margin: 30px 0 0;
          color: #111;
          font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco,
            Consolas, "Liberation Mono", monospace;
          font-size: 32px;
          opacity: 0;
          animation: finalUrl var(--duration) linear infinite;
        }

        @keyframes introGroup {
          0%,
          2%,
          17%,
          100% {
            opacity: 0;
            transform: translateY(22px);
          }
          4%,
          15.5% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes introTitle {
          0%,
          3% {
            transform: scale(0.92);
          }
          4% {
            transform: scale(1);
          }
          8% {
            transform: scale(1);
            opacity: 1;
          }
          12%,
          100% {
            transform: scale(0.001);
            opacity: 0;
          }
        }

        @keyframes introDescription {
          0%,
          8% {
            transform: scale(0.001);
          }
          12%,
          100% {
            transform: scale(1.42);
          }
        }

        @keyframes recordText {
          0%,
          16%,
          40%,
          100% {
            opacity: 0;
            transform: translateY(22px);
          }
          18%,
          35% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes prepareLabel {
          0%,
          40%,
          65%,
          100% {
            opacity: 0;
          }
          42%,
          62% {
            opacity: 1;
          }
        }

        @keyframes publishText {
          0%,
          65%,
          84%,
          100% {
            opacity: 0;
            transform: translateY(22px);
          }
          68%,
          80% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes prepareHeadingOne {
          0%,
          40%,
          50%,
          100% {
            opacity: 0;
            transform: translateY(22px);
          }
          42% {
            opacity: 1;
            transform: translateY(0);
          }
          48% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes prepareHeadingTwo {
          0%,
          49%,
          58%,
          100% {
            opacity: 0;
            transform: translateY(22px);
          }
          51% {
            opacity: 1;
            transform: translateY(0);
          }
          56% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes prepareHeadingThree {
          0%,
          57%,
          66%,
          100% {
            opacity: 0;
            transform: translateY(22px);
          }
          59% {
            opacity: 1;
            transform: translateY(0);
          }
          64% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes recordScene {
          0%,
          16%,
          38% {
            opacity: 0;
          }
          18%,
          35% {
            opacity: 1;
          }
          100% {
            opacity: 0;
          }
        }

        @keyframes noteIn {
          0%,
          17% {
            opacity: 0;
            transform: translateX(-38px) rotate(calc((var(--i) - 1) * -5deg));
          }
          21%,
          31% {
            opacity: 1;
            transform: translate(calc(var(--i) * 1rem), calc(var(--i) * 1.65rem))
              rotate(calc((var(--i) - 1) * 4deg));
          }
          36% {
            opacity: 1;
            transform: translate(calc(280px - var(--i) * 38px), calc(348px - var(--i) * 22px))
              scale(0.24)
              rotate(0deg);
          }
          39%,
          100% {
            opacity: 0;
            transform: translate(calc(280px - var(--i) * 38px), calc(348px - var(--i) * 22px))
              scale(0.12)
              rotate(0deg);
          }
        }

        @keyframes commitIn {
          0%,
          18% {
            opacity: 0;
            transform: translateX(34px);
          }
          23%,
          31% {
            opacity: 1;
            transform: translateX(0);
          }
          36% {
            opacity: 1;
            transform: translate(-620px, 372px) scale(0.24);
          }
          39%,
          100% {
            opacity: 0;
            transform: translate(-620px, 372px) scale(0.12);
          }
        }

        @keyframes envelopeJourney {
          0%,
          30% {
            opacity: 0;
            transform: translateY(72px) scale(0.82);
          }
          33%,
          62% {
            opacity: 1;
            transform: translateY(0) scale(0.9);
          }
          68% {
            opacity: 1;
            transform: translate(310px, -220px) scale(1);
          }
          84% {
            opacity: 0;
            transform: translate(1540px, -900px) rotate(-14deg) scale(0.48);
          }
          100% {
            opacity: 0;
            transform: translate(1540px, -900px) rotate(-14deg) scale(0.48);
          }
        }

        @keyframes letterSlide {
          0%,
          40% {
            transform: translateY(0);
          }
          58%,
          100% {
            transform: translateY(42%) scaleY(0.8);
          }
        }

        @keyframes sealFlap {
          0%,
          54% {
            transform: rotateX(0deg);
          }
          64%,
          100% {
            transform: rotateX(180deg);
          }
        }

        @keyframes waxSeal {
          0%,
          58% {
            transform: translate(-50%, -50%) scale(0);
          }
          66%,
          100% {
            transform: translate(-50%, -50%) scale(1);
          }
        }

        @keyframes editorScene {
          0%,
          41% {
            opacity: 0;
            transform: translate(24px, -44%) scale(0.96);
          }
          44%,
          59% {
            opacity: 1;
            transform: translate(0, -44%) scale(1);
          }
          64%,
          100% {
            opacity: 0;
            transform: translate(-8vw, -44%) scale(0.9);
          }
        }

        @keyframes oldVersion {
          0%,
          45% {
            opacity: 1;
            text-decoration: none;
          }
          51%,
          100% {
            opacity: 0;
            text-decoration: none;
          }
        }

        @keyframes newVersion {
          0%,
          46% {
            opacity: 0;
            transform: translateY(0.7rem);
          }
          52%,
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes dependencyUpdate {
          0%,
          46% {
            opacity: 0.36;
            transform: translateX(0);
          }
          52%,
          100% {
            opacity: 1;
            transform: translateX(0.3rem);
          }
        }

        @keyframes fieldHighlight {
          0%,
          46% {
            opacity: 0;
            transform: scaleX(0.72);
          }
          49% {
            opacity: 1;
            transform: scaleX(1);
          }
          56% {
            opacity: 1;
            transform: scaleX(1);
          }
          62%,
          100% {
            opacity: 0;
            transform: scaleX(1);
          }
        }

        @keyframes tokenPop {
          0%,
          46% {
            transform: translateY(0);
          }
          49% {
            transform: translateY(-0.08em);
          }
          54%,
          100% {
            transform: translateY(0);
          }
        }

        @keyframes registryScene {
          0%,
          70% {
            opacity: 0;
            transform: translate(-50%, 22px);
          }
          74%,
          83% {
            opacity: 1;
            transform: translate(-50%, 0);
          }
          88%,
          100% {
            opacity: 0;
            transform: translate(-50%, 22px);
          }
        }

        @keyframes finalScene {
          0%,
          86% {
            opacity: 0;
            transform: scale(0.96);
          }
          89%,
          98% {
            opacity: 1;
            transform: scale(1);
          }
          100% {
            opacity: 0;
            transform: scale(1.02);
          }
        }

        @keyframes finalUrl {
          0%,
          89% {
            opacity: 0;
            transform: translateY(10px);
          }
          91%,
          98% {
            opacity: 1;
            transform: translateY(0);
          }
          100% {
            opacity: 0;
            transform: translateY(-8px);
          }
        }

        @keyframes finalLink {
          0%,
          93% {
            opacity: 0;
            transform: translateY(10px);
          }
          95%,
          98% {
            opacity: 1;
            transform: translateY(0);
          }
          100% {
            opacity: 0;
            transform: translateY(-8px);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          *,
          *::before,
          *::after {
            animation-duration: 1ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 1ms !important;
          }

          .intro-copy {
            opacity: 1;
            transform: none;
          }
        }

        @media (max-width: 760px) {
          .phase-copy {
            top: 2.2rem;
          }

          .record-scene {
            transform: translateY(4vh);
          }

          .changelog-stack {
            left: 1rem;
            top: 35vh;
            width: calc(100vw - 2rem);
          }

          .commit-lane {
            left: 1rem;
            right: 1rem;
            top: 62vh;
            width: auto;
          }

          .package-editor {
            left: 1rem;
            right: 1rem;
            top: 65%;
            width: auto;
          }

          .envelope-wrap {
            top: 50%;
            width: min(76vw, 19rem);
          }

          .registry-strip {
            bottom: 2rem;
            width: calc(100vw - 2rem);
            justify-content: center;
          }
        }
      `}</style>
    </main>
  );
}
