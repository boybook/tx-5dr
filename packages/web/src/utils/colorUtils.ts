/**
 * 颜色处理工具函数
 */

/**
 * 将HEX颜色转换为RGB
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : null;
}

/**
 * 将HEX颜色转换为RGBA字符串
 */
export function hexToRgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/**
 * 将RGB转换为HEX
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map(x => {
    const hex = Math.round(x).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("");
}

/**
 * 将RGB转换为HSL
 */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * 将HSL转换为RGB
 */
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h /= 360;
  s /= 100;
  l /= 100;

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };

  let r, g, b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

/**
 * 计算颜色的相对亮度（基于WCAG标准）
 */
export function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * 加深颜色，用于文字显示
 * @param hex 原始颜色
 * @param factor 加深程度 (0-1)，值越大越深
 */
export function darkenColor(hex: string, factor: number = 0.3): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  
  // 降低亮度，确保文字可读性
  const newLightness = Math.max(hsl.l * (1 - factor), 15); // 最低亮度为15%
  
  const newRgb = hslToRgb(hsl.h, hsl.s, newLightness);
  return rgbToHex(newRgb.r, newRgb.g, newRgb.b);
}

/**
 * 变亮颜色
 * @param hex 原始颜色
 * @param factor 变亮程度 (0-1)
 */
export function lightenColor(hex: string, factor: number = 0.3): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  
  // 提高亮度
  const newLightness = Math.min(hsl.l + (100 - hsl.l) * factor, 85); // 最高亮度为85%
  
  const newRgb = hslToRgb(hsl.h, hsl.s, newLightness);
  return rgbToHex(newRgb.r, newRgb.g, newRgb.b);
}

/**
 * 为Badge/Chip生成合适的颜色方案
 * @param baseColor 基础颜色
 * @param isSpecialMessage 是否为特殊消息（需要全行背景色）
 */
export function getBadgeColors(baseColor: string, isSpecialMessage: boolean = false) {
  const rgb = hexToRgb(baseColor);
  if (!rgb) {
    return {
      backgroundColor: baseColor,
      textColor: '#000000',
      borderColor: baseColor,
    };
  }

  if (isSpecialMessage) {
    // 特殊消息使用深色文字和浅色背景
    const backgroundColor = lightenColor(baseColor, 0.8); // 很浅的背景
    const textColor = darkenColor(baseColor, 0.4); // 深色文字
    const borderColor = darkenColor(baseColor, 0.2); // 中等深度边框
    
    return {
      backgroundColor,
      textColor,
      borderColor,
    };
  } else {
    // 非特殊消息（右侧颜色条模式）使用更强烈的对比
    const backgroundColor = lightenColor(baseColor, 0.7);
    const textColor = darkenColor(baseColor, 0.5);
    const borderColor = baseColor;
    
    return {
      backgroundColor,
      textColor,
      borderColor,
    };
  }
}
