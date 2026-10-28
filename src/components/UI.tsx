import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "modal-wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        <div>
          <h2 id="modal-title">{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          aria-label="关闭对话框"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M5 7c5-1 9 1 11 4 2-3 6-5 11-4v19c-5-1-9 0-11 3-2-3-6-4-11-3V7Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M16 11v18M9 13l3 1m8 0 3-1M9 19l3 1m8 0 3-1"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function HeroArt() {
  return (
    <svg
      className="hero-art"
      viewBox="0 0 360 280"
      fill="none"
      aria-hidden="true"
    >
      <ellipse cx="195" cy="239" rx="119" ry="15" fill="var(--art-shadow)" />
      <circle cx="195" cy="125" r="99" fill="var(--art-circle)" />
      <circle
        cx="195"
        cy="125"
        r="116"
        stroke="var(--art-line)"
        strokeDasharray="3 8"
      />
      <path
        d="M91 82c-15 23-25 48-22 77M280 75c16 23 26 50 26 74"
        stroke="var(--art-line)"
        strokeLinecap="round"
      />
      <path
        d="m265 47 3-10m8 14 8-5M84 167l-11 4m14 6-6 8"
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M193 214v-81c0-19 5-39 18-59"
        stroke="var(--primary)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M196 151c-29 0-46-16-48-37 28 0 46 14 48 37Z"
        fill="var(--art-leaf)"
      />
      <path
        d="M199 129c25-4 39-19 39-40-26 4-39 17-39 40Z"
        fill="var(--primary)"
      />
      <path
        d="M207 91c-18-12-23-31-15-51 18 12 23 30 15 51Z"
        fill="var(--art-leaf)"
      />
      <path
        d="M212 76c24-1 39-15 42-35-25 0-39 13-42 35Z"
        fill="var(--primary)"
      />
      <path
        d="M167 180h54l-8 47a10 10 0 0 1-10 8h-19a10 10 0 0 1-10-8l-7-47Z"
        fill="var(--art-pot)"
      />
      <path
        d="M163 180a5 5 0 0 1 5-5h53a5 5 0 0 1 5 5v7h-63v-7Z"
        fill="var(--art-pot-light)"
      />
      <path
        d="m79 211 53-12 44 18-54 15-43-21Z"
        fill="var(--art-book)"
        stroke="var(--primary)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="m79 211 1 14 43 21 53-15v-14m-53 15v14"
        fill="var(--surface)"
        stroke="var(--primary)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="m86 221 33 16m9-1 40-11"
        stroke="var(--art-line)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M243 200h28v28a14 14 0 0 1-28 0v-28Z"
        fill="var(--art-book)"
        stroke="var(--primary)"
        strokeWidth="1.4"
      />
      <path
        d="M271 204h5a8 8 0 0 1 0 16h-5m-23-33c-5-7 7-8 1-16m11 17c-5-7 7-8 1-16"
        stroke="var(--primary)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="m105 59 6 9 11 1-7 8 2 10-10-5-9 5 1-10-7-8 10-1 3-9Z"
        fill="var(--art-star)"
      />
      <circle cx="291" cy="180" r="5" fill="var(--art-star)" />
      <circle cx="126" cy="125" r="3" fill="var(--primary)" />
      <path
        d="M284 111v12m-6-6h12"
        stroke="var(--art-line)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CourseArt({ kind }: { kind: string }) {
  if (kind === "derivative")
    return (
      <svg viewBox="0 0 280 126" fill="none" aria-hidden="true">
        <path d="M29 100h224M57 111V17" stroke="currentColor" opacity=".25" />
        <path
          d="M64 91c44-1 69-14 95-37 20-18 43-27 69-28"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <path
          d="m102 103 99-93"
          stroke="currentColor"
          opacity=".45"
          strokeWidth="1.5"
          strokeDasharray="5 4"
        />
        <circle cx="157" cy="54" r="5" fill="currentColor" />
        <circle cx="157" cy="54" r="12" stroke="currentColor" opacity=".25" />
        <text
          x="210"
          y="83"
          fill="currentColor"
          fontSize="20"
          fontFamily="Georgia"
          fontStyle="italic"
        >
          f′(x)
        </text>
        <path
          d="M157 58v42M62 54h90"
          stroke="currentColor"
          opacity=".18"
          strokeDasharray="3 4"
        />
      </svg>
    );
  if (kind === "probability")
    return (
      <svg viewBox="0 0 280 126" fill="none" aria-hidden="true">
        <circle
          cx="117"
          cy="62"
          r="40"
          fill="currentColor"
          fillOpacity=".06"
          stroke="currentColor"
          strokeOpacity=".55"
          strokeWidth="1.5"
        />
        <circle
          cx="166"
          cy="62"
          r="40"
          fill="currentColor"
          fillOpacity=".08"
          stroke="currentColor"
          strokeOpacity=".55"
          strokeWidth="1.5"
        />
        <text
          x="96"
          y="68"
          fontSize="18"
          fill="currentColor"
          fontFamily="Georgia"
          fontStyle="italic"
        >
          A
        </text>
        <text
          x="174"
          y="68"
          fontSize="18"
          fill="currentColor"
          fontFamily="Georgia"
          fontStyle="italic"
        >
          B
        </text>
        <text
          x="122"
          y="118"
          fontSize="13"
          fill="currentColor"
          fontFamily="Georgia"
        >
          P(A | B)
        </text>
        <path
          d="m62 25 3-5m156 76 4 3"
          stroke="currentColor"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <svg viewBox="0 0 280 126" fill="none" aria-hidden="true">
      <rect
        x="54"
        y="19"
        width="174"
        height="93"
        rx="8"
        stroke="currentColor"
        strokeOpacity=".45"
        strokeWidth="1.5"
      />
      <path d="M54 41h174" stroke="currentColor" strokeOpacity=".2" />
      <circle cx="66" cy="30" r="2" fill="currentColor" opacity=".5" />
      <circle cx="74" cy="30" r="2" fill="currentColor" opacity=".35" />
      <circle cx="82" cy="30" r="2" fill="currentColor" opacity=".2" />
      <text
        x="71"
        y="65"
        fill="currentColor"
        fontSize="12"
        fontFamily="monospace"
      >
        for idea in curiosity:
      </text>
      <text
        x="85"
        y="86"
        fill="currentColor"
        fontSize="12"
        fontFamily="monospace"
        opacity=".7"
      >
        learn(idea)
      </text>
      <path d="m198 91 5-5-5-5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
