type P = { className?: string };

const base = (path: React.ReactNode) =>
  function Icon({ className = 'h-5 w-5' }: P) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };

export const SearchIcon = base(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.8-3.8" />
  </>
);
export const UserIcon = base(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-3.6 4.5-5.4 8-5.4s6.5 1.8 8 5.4" />
  </>
);
export const BagIcon = base(
  <>
    <path d="M5.5 8h13l-1 12.5h-11L5.5 8Z" />
    <path d="M9 10V6.5a3 3 0 0 1 6 0V10" />
  </>
);
export const MenuIcon = base(
  <>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </>
);
export const HomeIcon = base(
  <>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </>
);
export const BoxIcon = base(
  <>
    <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
    <path d="M4 7l8 4 8-4M12 11v10" />
  </>
);
export const OrdersIcon = base(
  <>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h4" />
  </>
);
export const TagIcon = base(
  <>
    <path d="M3.5 12.5v-9h9L21 12l-8.5 8.5L3.5 12.5Z" />
    <circle cx="8" cy="8" r="1.4" />
  </>
);
export const TruckIcon = base(
  <>
    <path d="M2.5 6h12v11h-12zM14.5 10h4l3 3.5V17h-7" />
    <circle cx="6.5" cy="17.5" r="1.8" />
    <circle cx="17.5" cy="17.5" r="1.8" />
  </>
);
export const ChartIcon = base(
  <>
    <path d="M4 3v18h17" />
    <path d="M8 16v-5M12.5 16V8M17 16v-8" />
  </>
);
export const SettingsIcon = base(
  <>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
  </>
);
export const FileIcon = base(
  <>
    <path d="M6 2.5h8L19 7.5v14H6z" />
    <path d="M13.5 2.5v5.5H19M9 12h6M9 15.5h6" />
  </>
);
export const PenIcon = base(
  <>
    <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" />
    <path d="m14.5 6.5 3 3" />
  </>
);
export const PercentIcon = base(
  <>
    <path d="M19 5L5 19" />
    <circle cx="7" cy="7" r="2.5" />
    <circle cx="17" cy="17" r="2.5" />
  </>
);
export const ArrowRightIcon = base(
  <>
    <path d="M4 12h16m-6-6 6 6-6 6" />
  </>
);
export const CheckIcon = base(
  <>
    <path d="m4.5 12.5 5 5L20 6.5" />
  </>
);
export const ShieldIcon = base(
  <>
    <path d="M12 3 5 5.8v5.4c0 4.6 3 8 7 9.8 4-1.8 7-5.2 7-9.8V5.8L12 3Z" />
    <path d="m9 11.5 2.2 2.2L15.5 9" />
  </>
);
export const ReturnIcon = base(
  <>
    <path d="M3.5 8.5h11a5 5 0 0 1 0 10H8" />
    <path d="M7 4.5 3.5 8.5 7 12.5" />
  </>
);
export const StoreIcon = base(
  <>
    <path d="M4 10.5 5.5 4h13L20 10.5M4 10.5V20h16v-9.5M4 10.5h16M9.5 20v-5.5h5V20" />
  </>
);
