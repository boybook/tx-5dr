/**
 * 呼号前缀信息
 */
export interface PrefixInfo {
  prefix: string;
  country: string;
  dxccEntity: string;
  cqZone: number;
  ituZone: number;
  continent: string;
}

/**
 * 频段信息
 */
export interface BandInfo {
  band: string;
  frequency: number;
}

/**
 * 呼号分析工具类
 */
export class CallsignUtils {
  /**
   * 简化的前缀数据库（实际应用中应该使用完整的数据库）
   * 这里只包含一些常见的前缀示例
   */
  private static readonly PREFIX_DATABASE: PrefixInfo[] = [
    // 中国
    { prefix: 'BA', country: 'China', dxccEntity: 'China', cqZone: 24, ituZone: 44, continent: 'AS' },
    { prefix: 'BD', country: 'China', dxccEntity: 'China', cqZone: 24, ituZone: 44, continent: 'AS' },
    { prefix: 'BG', country: 'China', dxccEntity: 'China', cqZone: 24, ituZone: 44, continent: 'AS' },
    { prefix: 'BH', country: 'China', dxccEntity: 'China', cqZone: 24, ituZone: 44, continent: 'AS' },
    { prefix: 'BY', country: 'China', dxccEntity: 'China', cqZone: 24, ituZone: 44, continent: 'AS' },
    
    // 美国
    { prefix: 'K', country: 'USA', dxccEntity: 'United States', cqZone: 5, ituZone: 8, continent: 'NA' },
    { prefix: 'W', country: 'USA', dxccEntity: 'United States', cqZone: 5, ituZone: 8, continent: 'NA' },
    { prefix: 'N', country: 'USA', dxccEntity: 'United States', cqZone: 5, ituZone: 8, continent: 'NA' },
    { prefix: 'AA', country: 'USA', dxccEntity: 'United States', cqZone: 5, ituZone: 8, continent: 'NA' },
    { prefix: 'AB', country: 'USA', dxccEntity: 'United States', cqZone: 5, ituZone: 8, continent: 'NA' },
    
    // 日本
    { prefix: 'JA', country: 'Japan', dxccEntity: 'Japan', cqZone: 25, ituZone: 45, continent: 'AS' },
    { prefix: 'JH', country: 'Japan', dxccEntity: 'Japan', cqZone: 25, ituZone: 45, continent: 'AS' },
    { prefix: '7J', country: 'Japan', dxccEntity: 'Japan', cqZone: 25, ituZone: 45, continent: 'AS' },
    
    // 德国
    { prefix: 'DA', country: 'Germany', dxccEntity: 'Germany', cqZone: 14, ituZone: 28, continent: 'EU' },
    { prefix: 'DB', country: 'Germany', dxccEntity: 'Germany', cqZone: 14, ituZone: 28, continent: 'EU' },
    { prefix: 'DC', country: 'Germany', dxccEntity: 'Germany', cqZone: 14, ituZone: 28, continent: 'EU' },
    { prefix: 'DD', country: 'Germany', dxccEntity: 'Germany', cqZone: 14, ituZone: 28, continent: 'EU' },
    { prefix: 'DK', country: 'Germany', dxccEntity: 'Germany', cqZone: 14, ituZone: 28, continent: 'EU' },
    { prefix: 'DL', country: 'Germany', dxccEntity: 'Germany', cqZone: 14, ituZone: 28, continent: 'EU' },
    
    // 英国
    { prefix: 'G', country: 'England', dxccEntity: 'England', cqZone: 14, ituZone: 27, continent: 'EU' },
    { prefix: 'M', country: 'England', dxccEntity: 'England', cqZone: 14, ituZone: 27, continent: 'EU' },
    { prefix: '2E', country: 'England', dxccEntity: 'England', cqZone: 14, ituZone: 27, continent: 'EU' },
    
    // 更多前缀可以从完整的前缀数据库加载
  ];
  
  /**
   * 提取呼号前缀
   * @param callsign 呼号
   * @returns 前缀
   */
  static extractPrefix(callsign: string): string {
    if (!callsign) return '';
    
    // 移除常见的后缀标识符（如 /P, /M, /MM, /AM, /QRP等）
    const cleanCallsign = callsign.split('/')[0].toUpperCase();
    
    // 查找最长匹配的前缀
    let longestMatch = '';
    for (const prefixInfo of this.PREFIX_DATABASE) {
      if (cleanCallsign.startsWith(prefixInfo.prefix) && prefixInfo.prefix.length > longestMatch.length) {
        longestMatch = prefixInfo.prefix;
      }
    }
    
    // 如果没有找到匹配的前缀，尝试提取前1-2个字符作为前缀
    if (!longestMatch) {
      // 如果第二个字符是数字，通常前缀只有一个字母
      if (cleanCallsign.length >= 2 && /\d/.test(cleanCallsign[1])) {
        longestMatch = cleanCallsign[0];
      } else if (cleanCallsign.length >= 2) {
        // 否则取前两个字符
        longestMatch = cleanCallsign.substring(0, 2);
      } else {
        longestMatch = cleanCallsign;
      }
    }
    
    return longestMatch;
  }
  
  /**
   * 获取呼号的前缀信息
   * @param callsign 呼号
   * @returns 前缀信息
   */
  static getPrefixInfo(callsign: string): PrefixInfo | null {
    const prefix = this.extractPrefix(callsign);
    return this.PREFIX_DATABASE.find(info => info.prefix === prefix) || null;
  }
  
  /**
   * 获取CQ分区
   * @param callsign 呼号
   * @returns CQ分区号
   */
  static getCQZone(callsign: string): number | null {
    const info = this.getPrefixInfo(callsign);
    return info ? info.cqZone : null;
  }
  
  /**
   * 获取ITU分区
   * @param callsign 呼号
   * @returns ITU分区号
   */
  static getITUZone(callsign: string): number | null {
    const info = this.getPrefixInfo(callsign);
    return info ? info.ituZone : null;
  }
  
  /**
   * 获取DXCC实体
   * @param callsign 呼号
   * @returns DXCC实体名称
   */
  static getDXCCEntity(callsign: string): string | null {
    const info = this.getPrefixInfo(callsign);
    return info ? info.dxccEntity : null;
  }
  
  /**
   * 验证呼号格式是否有效
   * @param callsign 呼号
   * @returns 是否有效
   */
  static isValidCallsign(callsign: string): boolean {
    if (!callsign || callsign.length < 3) return false;
    
    // 基本的呼号格式验证
    // 呼号通常包含字母和数字，可能有/分隔符
    const callsignPattern = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{1,4}(\/[A-Z0-9]+)?$/i;
    return callsignPattern.test(callsign);
  }
  
  /**
   * 根据频率获取频段
   * @param frequency 频率（Hz）
   * @returns 频段信息
   */
  static getBandFromFrequency(frequency: number): string {
    const freqMHz = frequency / 1000000;
    
    if (freqMHz >= 1.8 && freqMHz <= 2.0) return '160m';
    if (freqMHz >= 3.5 && freqMHz <= 4.0) return '80m';
    if (freqMHz >= 5.0 && freqMHz <= 5.5) return '60m';
    if (freqMHz >= 7.0 && freqMHz <= 7.3) return '40m';
    if (freqMHz >= 10.1 && freqMHz <= 10.15) return '30m';
    if (freqMHz >= 14.0 && freqMHz <= 14.35) return '20m';
    if (freqMHz >= 18.068 && freqMHz <= 18.168) return '17m';
    if (freqMHz >= 21.0 && freqMHz <= 21.45) return '15m';
    if (freqMHz >= 24.89 && freqMHz <= 24.99) return '12m';
    if (freqMHz >= 28.0 && freqMHz <= 29.7) return '10m';
    if (freqMHz >= 50 && freqMHz <= 54) return '6m';
    if (freqMHz >= 144 && freqMHz <= 148) return '2m';
    if (freqMHz >= 420 && freqMHz <= 450) return '70cm';
    
    return 'Unknown';
  }
  
  /**
   * 计算网格距离（公里）
   * @param grid1 网格1
   * @param grid2 网格2
   * @returns 距离（公里）
   */
  static calculateGridDistance(grid1: string, grid2: string): number | null {
    const coord1 = this.gridToCoordinates(grid1);
    const coord2 = this.gridToCoordinates(grid2);
    
    if (!coord1 || !coord2) return null;
    
    return this.haversineDistance(coord1, coord2);
  }
  
  /**
   * 将网格定位符转换为经纬度坐标
   * @param grid 网格定位符（如 "FN31"）
   * @returns 经纬度坐标
   */
  static gridToCoordinates(grid: string): { lat: number; lon: number } | null {
    if (!grid || grid.length < 4) return null;
    
    const upperGrid = grid.toUpperCase();
    
    // 提取字段
    const lon1 = upperGrid.charCodeAt(0) - 65; // A=0, R=17
    const lat1 = upperGrid.charCodeAt(1) - 65; // A=0, R=17
    const lon2 = parseInt(upperGrid[2]);
    const lat2 = parseInt(upperGrid[3]);
    
    if (isNaN(lon2) || isNaN(lat2)) return null;
    
    // 计算经纬度
    let lon = (lon1 * 20 + lon2 * 2) - 180 + 1;
    let lat = (lat1 * 10 + lat2) - 90 + 0.5;
    
    // 如果有子网格（6位网格）
    if (grid.length >= 6) {
      const lon3 = upperGrid.charCodeAt(4) - 65;
      const lat3 = upperGrid.charCodeAt(5) - 65;
      lon += lon3 * 5 / 60;
      lat += lat3 * 2.5 / 60;
    }
    
    return { lat, lon };
  }
  
  /**
   * 使用Haversine公式计算两点间的距离
   * @param coord1 坐标1
   * @param coord2 坐标2
   * @returns 距离（公里）
   */
  private static haversineDistance(
    coord1: { lat: number; lon: number },
    coord2: { lat: number; lon: number }
  ): number {
    const R = 6371; // 地球半径（公里）
    const dLat = this.toRadians(coord2.lat - coord1.lat);
    const dLon = this.toRadians(coord2.lon - coord1.lon);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRadians(coord1.lat)) * Math.cos(this.toRadians(coord2.lat)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  
  /**
   * 角度转弧度
   * @param degrees 角度
   * @returns 弧度
   */
  private static toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
} 