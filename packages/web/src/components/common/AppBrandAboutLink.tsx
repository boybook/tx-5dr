import React from 'react';
import { getAboutPageUrl } from '../../utils/aboutUrl';

export function AppBrandAboutLink() {
  const handleOpenAbout = () => {
    window.open(getAboutPageUrl(), '_blank', 'noopener,noreferrer');
  };

  return (
    <button
      type="button"
      onClick={handleOpenAbout}
      title="About TX-5DR"
      aria-label="Open About TX-5DR"
      className="cursor-pointer rounded-sm border-0 bg-transparent p-0 text-lg font-bold leading-normal text-default-800 transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      TX-5DR
    </button>
  );
}
