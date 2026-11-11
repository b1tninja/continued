import { Text } from "ink";
import React, { useEffect, useState } from "react";

import { getPolicyLevels } from "../permissions/policyLevels.js";

import {
  firstRunBannerText,
  markFirstRunBannerShown,
  shouldShowFirstRunBanner,
} from "./firstRunBannerState.js";

/** One line under the header for a first-time user; renders nothing otherwise. */
export const FirstRunBanner: React.FC = () => {
  const [show] = useState(() => shouldShowFirstRunBanner());
  useEffect(() => {
    if (show) {
      markFirstRunBannerShown();
    }
  }, [show]);
  if (!show) {
    return null;
  }
  return <Text color="dim">{firstRunBannerText(getPolicyLevels())}</Text>;
};
