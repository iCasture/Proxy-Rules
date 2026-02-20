/*
可选参数 (参数值中的空格请使用 "+" 替代):

title: 面板标题

availableContent: 支持时展示的文本内容, 支持占位符 #REGION_FLAG# #REGION_CODE# #REGION_NAME# #REGION_NAME_EN# #WARP_STATUS#, 分别对应地区国旗 地区编码 地区中文名称 地区英文名称 WARP

availableIcon: 支持时展示的图标

availableIconColor: 支持时展示的图标颜色

availableStyle: 支持时展示的样式, 参数可选值有 good, info, alert, error. 注意相应的 Icon / Color 会覆盖此设置

notAvailableContent: 不支持时展示的文本内容

notAvailableIcon: 不支持时展示的图标

notAvailableIconColor: 不支持时展示的图标颜色

notAvailableStyle: 不支持时展示的样式, 参数可选值有 good, info, alert, error. 注意相应的 Icon / Color 会覆盖此设置

errorContent: 检测失败时展示的文本内容

errorIcon: 检测失败时展示的图标

errorIconColor: 检测失败时展示的图标颜色

errorStyle: 检测失败时展示的样式, 参数可选值有 good, info, alert, error. 注意相应的 Icon / Color 会覆盖此设置

timeout: 检测超时时间, 单位毫秒, 默认 5000

- - - - - - -

Surge 使用示例:

[Panel]
nf_check = script-name=nf_check, title="Claude 支持检测", content="请刷新", update-interval=1

[Script]
nf_check = type=generic, timeout=30, script-path=https://raw.githubusercontent.com/iCasture/Proxy-Rules/refs/heads/master/Surge/Scripts/claude_check.js, argument=title=Claude+解锁检测

注意: Surge 本身的 timout 参数需要设置的稍长一点, 防止脚本在输出结果前就被 Surge 中断, 导致无输出. 由于脚本本身自带了超时处理功能, 因此无须担心网络异常导致的长时间卡死问题.

如果需要修改超时控制相关逻辑, 请使用脚本自带的参数.

- - - - - - -

Debug:

Surge 的 [Script] 支持 debug 参数. 设为 true 后可启用调试模式:

1. Surge Mac 会在每次执行前从文件系统重新加载脚本.
2. 对于 http-request / http-response 脚本, `console.log()` 也会出现在请求备注中.

示例：

[Panel]
nf_check = script-name=nf_check, title="Claude 支持检测", content="请刷新", update-interval=1

[Script]
nf_check = type=generic, script-path=https://raw.githubusercontent.com/iCasture/Proxy-Rules/refs/heads/master/Surge/Scripts/claude_check.js, argument=title=Claude+解锁检测, debug=true
*/

const TRACE_URL = "https://claude.ai/cdn-cgi/trace";
const WARP_ENABLED_STATES = ["plus", "on"];
const WARP_STATUS_YES = "Yes";
const WARP_STATUS_NO = "No";
const WARP_STATUS_UNKNOWN = "Unknown";
const SCRIPT_NAME = "claude_check";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36";

const STATUS_AVAILABLE = "available";
const STATUS_NOT_AVAILABLE = "not_available";
const STATUS_TIMEOUT = "timeout";
const STATUS_ERROR = "error";

const ERROR_TIMEOUT = "network_timeout";
const ERROR_GENERIC = "network_error";

const DEFAULT_OPTIONS = {
  title: "Claude",
  availableContent:
    "支持 | 地区: #REGION_FLAG# #REGION_NAME#\nCloudflare WARP: #WARP_STATUS#",
  availableIcon: "",
  availableIconColor: "",
  availableStyle: "good",
  notAvailableContent:
    "不支持 | 地区: #REGION_FLAG# #REGION_NAME#\nCloudflare WARP: #WARP_STATUS#",
  notAvailableIcon: "",
  notAvailableIconColor: "",
  notAvailableStyle: "alert",
  errorContent: "Request failed, please check your network.",
  errorIcon: "",
  errorIconColor: "",
  errorStyle: "error",
  timeout: 5000,
};

// https://support.claude.com/en/articles/8461763-where-can-i-access-claude
// https://www.anthropic.com/supported-countries
// https://platform.claude.com/docs/en/api/supported-regions
const SUPPORTED_REGIONS = {
  AL: { chinese: "阿尔巴尼亚", english: "Albania" },
  DZ: { chinese: "阿尔及利亚", english: "Algeria" },
  AD: { chinese: "安道尔", english: "Andorra" },
  AO: { chinese: "安哥拉", english: "Angola" },
  AG: { chinese: "安提瓜和巴布达", english: "Antigua and Barbuda" },
  AR: { chinese: "阿根廷", english: "Argentina" },
  AM: { chinese: "亚美尼亚", english: "Armenia" },
  AU: { chinese: "澳大利亚", english: "Australia" },
  AT: { chinese: "奥地利", english: "Austria" },
  AZ: { chinese: "阿塞拜疆", english: "Azerbaijan" },
  BS: { chinese: "巴哈马", english: "Bahamas" },
  BH: { chinese: "巴林", english: "Bahrain" },
  BD: { chinese: "孟加拉国", english: "Bangladesh" },
  BB: { chinese: "巴巴多斯", english: "Barbados" },
  BE: { chinese: "比利时", english: "Belgium" },
  BZ: { chinese: "伯利兹", english: "Belize" },
  BJ: { chinese: "贝宁", english: "Benin" },
  BT: { chinese: "不丹", english: "Bhutan" },
  BO: { chinese: "玻利维亚", english: "Bolivia" },
  BA: { chinese: "波斯尼亚和黑塞哥维那", english: "Bosnia and Herzegovina" },
  BW: { chinese: "博茨瓦纳", english: "Botswana" },
  BR: { chinese: "巴西", english: "Brazil" },
  BN: { chinese: "文莱", english: "Brunei" },
  BG: { chinese: "保加利亚", english: "Bulgaria" },
  BF: { chinese: "布基纳法索", english: "Burkina Faso" },
  BI: { chinese: "布隆迪", english: "Burundi" },
  CV: { chinese: "佛得角", english: "Cabo Verde" },
  KH: { chinese: "柬埔寨", english: "Cambodia" },
  CM: { chinese: "喀麦隆", english: "Cameroon" },
  CA: { chinese: "加拿大", english: "Canada" },
  TD: { chinese: "乍得", english: "Chad" },
  CL: { chinese: "智利", english: "Chile" },
  CO: { chinese: "哥伦比亚", english: "Colombia" },
  KM: { chinese: "科摩罗", english: "Comoros" },
  CG: { chinese: "刚果（布）", english: "Congo (Brazzaville)" },
  CR: { chinese: "哥斯达黎加", english: "Costa Rica" },
  CI: { chinese: "科特迪瓦", english: "Cote d'Ivoire" },
  HR: { chinese: "克罗地亚", english: "Croatia" },
  CY: { chinese: "塞浦路斯", english: "Cyprus" },
  CZ: { chinese: "捷克", english: "Czechia (Czech Republic)" },
  DK: { chinese: "丹麦", english: "Denmark" },
  DJ: { chinese: "吉布提", english: "Djibouti" },
  DM: { chinese: "多米尼克", english: "Dominica" },
  DO: { chinese: "多米尼加共和国", english: "Dominican Republic" },
  EC: { chinese: "厄瓜多尔", english: "Ecuador" },
  EG: { chinese: "埃及", english: "Egypt" },
  SV: { chinese: "萨尔瓦多", english: "El Salvador" },
  GQ: { chinese: "赤道几内亚", english: "Equatorial Guinea" },
  EE: { chinese: "爱沙尼亚", english: "Estonia" },
  SZ: { chinese: "埃斯瓦蒂尼", english: "Eswatini (Swaziland)" },
  FJ: { chinese: "斐济", english: "Fiji" },
  FI: { chinese: "芬兰", english: "Finland" },
  FR: { chinese: "法国", english: "France" },
  GA: { chinese: "加蓬", english: "Gabon" },
  GM: { chinese: "冈比亚", english: "Gambia" },
  GE: { chinese: "格鲁吉亚", english: "Georgia" },
  DE: { chinese: "德国", english: "Germany" },
  GH: { chinese: "加纳", english: "Ghana" },
  GR: { chinese: "希腊", english: "Greece" },
  GD: { chinese: "格林纳达", english: "Grenada" },
  GT: { chinese: "危地马拉", english: "Guatemala" },
  GN: { chinese: "几内亚", english: "Guinea" },
  GW: { chinese: "几内亚比绍", english: "Guinea-Bissau" },
  GY: { chinese: "圭亚那", english: "Guyana" },
  HT: { chinese: "海地", english: "Haiti" },
  VA: { chinese: "梵蒂冈", english: "Holy See (Vatican City)" },
  HN: { chinese: "洪都拉斯", english: "Honduras" },
  HU: { chinese: "匈牙利", english: "Hungary" },
  IS: { chinese: "冰岛", english: "Iceland" },
  IN: { chinese: "印度", english: "India" },
  ID: { chinese: "印度尼西亚", english: "Indonesia" },
  IQ: { chinese: "伊拉克", english: "Iraq" },
  IE: { chinese: "爱尔兰", english: "Ireland" },
  IL: { chinese: "以色列", english: "Israel" },
  IT: { chinese: "意大利", english: "Italy" },
  JM: { chinese: "牙买加", english: "Jamaica" },
  JP: { chinese: "日本", english: "Japan" },
  JO: { chinese: "约旦", english: "Jordan" },
  KZ: { chinese: "哈萨克斯坦", english: "Kazakhstan" },
  KE: { chinese: "肯尼亚", english: "Kenya" },
  KI: { chinese: "基里巴斯", english: "Kiribati" },
  KW: { chinese: "科威特", english: "Kuwait" },
  KG: { chinese: "吉尔吉斯斯坦", english: "Kyrgyzstan" },
  LA: { chinese: "老挝", english: "Laos" },
  LV: { chinese: "拉脱维亚", english: "Latvia" },
  LB: { chinese: "黎巴嫩", english: "Lebanon" },
  LS: { chinese: "莱索托", english: "Lesotho" },
  LR: { chinese: "利比里亚", english: "Liberia" },
  LI: { chinese: "列支敦士登", english: "Liechtenstein" },
  LT: { chinese: "立陶宛", english: "Lithuania" },
  LU: { chinese: "卢森堡", english: "Luxembourg" },
  MG: { chinese: "马达加斯加", english: "Madagascar" },
  MW: { chinese: "马拉维", english: "Malawi" },
  MY: { chinese: "马来西亚", english: "Malaysia" },
  MV: { chinese: "马尔代夫", english: "Maldives" },
  MT: { chinese: "马耳他", english: "Malta" },
  MH: { chinese: "马绍尔群岛", english: "Marshall Islands" },
  MR: { chinese: "毛里塔尼亚", english: "Mauritania" },
  MU: { chinese: "毛里求斯", english: "Mauritius" },
  MX: { chinese: "墨西哥", english: "Mexico" },
  FM: { chinese: "密克罗尼西亚联邦", english: "Micronesia" },
  MD: { chinese: "摩尔多瓦", english: "Moldova" },
  MC: { chinese: "摩纳哥", english: "Monaco" },
  MN: { chinese: "蒙古", english: "Mongolia" },
  ME: { chinese: "黑山", english: "Montenegro" },
  MA: { chinese: "摩洛哥", english: "Morocco" },
  MZ: { chinese: "莫桑比克", english: "Mozambique" },
  NA: { chinese: "纳米比亚", english: "Namibia" },
  NR: { chinese: "瑙鲁", english: "Nauru" },
  NP: { chinese: "尼泊尔", english: "Nepal" },
  NL: { chinese: "荷兰", english: "Netherlands" },
  NZ: { chinese: "新西兰", english: "New Zealand" },
  NE: { chinese: "尼日尔", english: "Niger" },
  NG: { chinese: "尼日利亚", english: "Nigeria" },
  MK: { chinese: "北马其顿", english: "North Macedonia" },
  NO: { chinese: "挪威", english: "Norway" },
  OM: { chinese: "阿曼", english: "Oman" },
  PK: { chinese: "巴基斯坦", english: "Pakistan" },
  PW: { chinese: "帕劳", english: "Palau" },
  PS: { chinese: "巴勒斯坦", english: "Palestine" },
  PA: { chinese: "巴拿马", english: "Panama" },
  PG: { chinese: "巴布亚新几内亚", english: "Papua New Guinea" },
  PY: { chinese: "巴拉圭", english: "Paraguay" },
  PE: { chinese: "秘鲁", english: "Peru" },
  PH: { chinese: "菲律宾", english: "Philippines" },
  PL: { chinese: "波兰", english: "Poland" },
  PT: { chinese: "葡萄牙", english: "Portugal" },
  QA: { chinese: "卡塔尔", english: "Qatar" },
  RO: { chinese: "罗马尼亚", english: "Romania" },
  RW: { chinese: "卢旺达", english: "Rwanda" },
  KN: { chinese: "圣基茨和尼维斯", english: "Saint Kitts and Nevis" },
  LC: { chinese: "圣卢西亚", english: "Saint Lucia" },
  VC: {
    chinese: "圣文森特和格林纳丁斯",
    english: "Saint Vincent and the Grenadines",
  },
  WS: { chinese: "萨摩亚", english: "Samoa" },
  SM: { chinese: "圣马力诺", english: "San Marino" },
  ST: { chinese: "圣多美和普林西比", english: "Sao Tome and Principe" },
  SA: { chinese: "沙特阿拉伯", english: "Saudi Arabia" },
  SN: { chinese: "塞内加尔", english: "Senegal" },
  RS: { chinese: "塞尔维亚", english: "Serbia" },
  SC: { chinese: "塞舌尔", english: "Seychelles" },
  SL: { chinese: "塞拉利昂", english: "Sierra Leone" },
  SG: { chinese: "新加坡", english: "Singapore" },
  SK: { chinese: "斯洛伐克", english: "Slovakia" },
  SI: { chinese: "斯洛文尼亚", english: "Slovenia" },
  SB: { chinese: "所罗门群岛", english: "Solomon Islands" },
  ZA: { chinese: "南非", english: "South Africa" },
  KR: { chinese: "韩国", english: "South Korea" },
  ES: { chinese: "西班牙", english: "Spain" },
  LK: { chinese: "斯里兰卡", english: "Sri Lanka" },
  SR: { chinese: "苏里南", english: "Suriname" },
  SE: { chinese: "瑞典", english: "Sweden" },
  CH: { chinese: "瑞士", english: "Switzerland" },
  TW: { chinese: "中国台湾", english: "Taiwan" },
  TJ: { chinese: "塔吉克斯坦", english: "Tajikistan" },
  TZ: { chinese: "坦桑尼亚", english: "Tanzania" },
  TH: { chinese: "泰国", english: "Thailand" },
  TL: { chinese: "东帝汶", english: "Timor-Leste (East Timor)" },
  TG: { chinese: "多哥", english: "Togo" },
  TO: { chinese: "汤加", english: "Tonga" },
  TT: { chinese: "特立尼达和多巴哥", english: "Trinidad and Tobago" },
  TN: { chinese: "突尼斯", english: "Tunisia" },
  TR: { chinese: "土耳其", english: "Turkey" },
  TM: { chinese: "土库曼斯坦", english: "Turkmenistan" },
  TV: { chinese: "图瓦卢", english: "Tuvalu" },
  UG: { chinese: "乌干达", english: "Uganda" },
  UA: { chinese: "乌克兰", english: "Ukraine" },
  AE: { chinese: "阿拉伯联合酋长国", english: "United Arab Emirates" },
  GB: { chinese: "英国", english: "United Kingdom" },
  US: { chinese: "美国", english: "United States of America" },
  UY: { chinese: "乌拉圭", english: "Uruguay" },
  UZ: { chinese: "乌兹别克斯坦", english: "Uzbekistan" },
  VU: { chinese: "瓦努阿图", english: "Vanuatu" },
  VN: { chinese: "越南", english: "Vietnam" },
  ZM: { chinese: "赞比亚", english: "Zambia" },
  ZW: { chinese: "津巴布韦", english: "Zimbabwe" },
};

const options = getArguments();
const panel = {
  title: options.title,
};

(async () => {
  const { region, status, warpState: rawWarpState } = await testClaude();
  const warpStatus = mapWarpStateToStatus(rawWarpState);
  console.log(
    `[${SCRIPT_NAME}] testClaude: region=${region}, status=${status}, rawWarpState=${rawWarpState}, warpStatus=${warpStatus}`,
  );
  setPanelByStatus(panel, options, status, region, warpStatus);
})()
  .catch((error) => {
    console.log(`[${SCRIPT_NAME}] main: error=${error}`);
    setPanelByStatus(panel, options, STATUS_ERROR, "", WARP_STATUS_UNKNOWN);
  })
  .finally(() => {
    $done(panel);
  });

/**
 * Run Claude probe and map result to status.
 *
 * @returns {Promise<{region: string, status: string, warpState: string}>}
 */
async function testClaude() {
  try {
    const traceInfo = await withTimeout(fetchTraceInfo(), options.timeout);
    const normalizedCountryCode = (traceInfo.loc || "").toUpperCase();
    const warpState = traceInfo.warp || "";
    const regionInfo = SUPPORTED_REGIONS[normalizedCountryCode];
    const isSupported = Boolean(regionInfo);
    const status = isSupported ? STATUS_AVAILABLE : STATUS_NOT_AVAILABLE;
    return { region: normalizedCountryCode, status, warpState };
  } catch (error) {
    console.log(`[${SCRIPT_NAME}] testClaude: error=${error}`);
    if (error === ERROR_TIMEOUT) {
      return { region: "", status: STATUS_TIMEOUT, warpState: "" };
    }
    return { region: "", status: STATUS_ERROR, warpState: "" };
  }
}

/**
 * Fetch Cloudflare trace metadata from Claude endpoint.
 *
 * @returns {Promise<Object>} Parsed key-value map from trace response.
 */
function fetchTraceInfo() {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      url: TRACE_URL,
      headers: {
        "Accept-Language": "en",
        "User-Agent": USER_AGENT,
      },
    };

    $httpClient.get(requestOptions, (error, response, data) => {
      if (error || !data) {
        console.log(
          `[${SCRIPT_NAME}] fetchTraceInfo: requestError=${error}, status=${response?.status}, hasData=${Boolean(data)}`,
        );
        reject(ERROR_GENERIC);
        return;
      }

      const traceInfo = data.split("\n").reduce((trace, line) => {
        const [key, value] = line.split("=");
        if (key && value) trace[key] = value;
        return trace;
      }, {});

      resolve(traceInfo);
    });
  });
}

/**
 * Wrap a promise with timeout control.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} delay
 * @returns {Promise<T>}
 */
function withTimeout(promise, delay = 5000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.log(
        `[${SCRIPT_NAME}] withTimeout: event=timeout, delay=${delay}`,
      );
      reject(ERROR_TIMEOUT);
    }, delay);
    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

/**
 * Apply icon settings if icon exists, otherwise apply style.
 *
 * @param {Object} targetPanel
 * @param {string} icon
 * @param {string} iconColor
 * @param {string | undefined} style
 */
function applyIconOrStyle(targetPanel, icon, iconColor, style) {
  if (icon) {
    targetPanel["icon"] = icon;
    targetPanel["icon-color"] = iconColor || undefined;
    delete targetPanel["style"];
    return;
  }

  if (style) {
    targetPanel["style"] = style;
  } else {
    delete targetPanel["style"];
  }

  delete targetPanel["icon"];
  delete targetPanel["icon-color"];
}

/**
 * Map Cloudflare trace warp state to display status.
 *
 * @param {string} rawWarpState
 * @returns {string}
 */
function mapWarpStateToStatus(rawWarpState) {
  const normalizedRawWarpState =
    typeof rawWarpState === "string" ? rawWarpState.trim().toLowerCase() : "";
  if (!normalizedRawWarpState) return WARP_STATUS_UNKNOWN;
  return WARP_ENABLED_STATES.includes(normalizedRawWarpState)
    ? WARP_STATUS_YES
    : WARP_STATUS_NO;
}

/**
 * Set panel appearance and content by unified status constants.
 *
 * @param {Object} targetPanel
 * @param {Object} parsedOptions
 * @param {string} status
 * @param {string} region
 * @param {string} warpStatus
 */
function setPanelByStatus(
  targetPanel,
  parsedOptions,
  status,
  region,
  warpStatus = WARP_STATUS_UNKNOWN,
) {
  switch (status) {
    case STATUS_AVAILABLE:
      applyIconOrStyle(
        targetPanel,
        parsedOptions.availableIcon,
        parsedOptions.availableIconColor,
        parsedOptions.availableStyle,
      );
      targetPanel["content"] = replaceRegionPlaceholder(
        parsedOptions.availableContent,
        region,
        warpStatus,
      );
      return;
    case STATUS_NOT_AVAILABLE:
      applyIconOrStyle(
        targetPanel,
        parsedOptions.notAvailableIcon,
        parsedOptions.notAvailableIconColor,
        parsedOptions.notAvailableStyle,
      );
      targetPanel["content"] = replaceRegionPlaceholder(
        parsedOptions.notAvailableContent,
        region,
        warpStatus,
      );
      return;
    default:
      applyIconOrStyle(
        targetPanel,
        parsedOptions.errorIcon,
        parsedOptions.errorIconColor,
        parsedOptions.errorStyle,
      );
      targetPanel["content"] = parsedOptions.errorContent;
  }
}

/**
 * Convert ISO country code to Emoji flag.
 *
 * @param {string} countryCode
 * @returns {string}
 */
function getCountryFlagEmoji(countryCode) {
  if (!countryCode) return "❓";
  if (!/^[A-Za-z]{2}$/.test(countryCode)) return "❓";

  let code = countryCode.toUpperCase();
  if (code === "TW") code = "CN";

  // if (!SUPPORTED_REGIONS[code]) return "❓";

  const codePoints = code.split("").map((char) => 127397 + char.charCodeAt());
  return String.fromCodePoint(...codePoints);
}

/**
 * Parse `$argument` key-value pairs.
 * `+` is treated as a space before decoding.
 * Blank keys are ignored after trimming.
 *
 * @param {string} argString
 * @returns {Object}
 */
function parseArguments(argString) {
  if (typeof argString !== "string" || !argString) return {};

  const parsedArguments = Object.create(null);
  const blockedKeys = new Set(["__proto__", "prototype", "constructor"]);

  for (const part of argString.split("&")) {
    if (!part) continue;

    const separatorIndex = part.indexOf("=");
    const rawKey = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
    const rawValue =
      separatorIndex === -1 ? "" : part.slice(separatorIndex + 1);

    // Treat "+" as spaces before decoding.
    const keySource = rawKey.replace(/\+/g, " ").trim();

    // Skip entries with an empty key after normalization.
    if (!keySource) continue;

    let key;
    try {
      key = decodeURIComponent(keySource);
    } catch {
      console.error(
        `[${SCRIPT_NAME}] parseArguments: event=decode_key_error, rawKey=${rawKey}`,
      );
      key = keySource;
    }

    if (!key) continue;
    if (blockedKeys.has(key)) continue;

    // Treat "+" as spaces before decoding.
    const valueSource = rawValue.replace(/\+/g, " ");

    let decodedValue;
    try {
      decodedValue = decodeURIComponent(valueSource);
    } catch {
      console.error(
        `[${SCRIPT_NAME}] parseArguments: event=decode_value_error, key=${key}`,
      );
      // Keep raw value on malformed encoding to avoid hard failure.
      decodedValue = valueSource;
    }

    parsedArguments[key] = decodedValue;
  }

  return parsedArguments;
}

/**
 * Get options by merging defaults and runtime arguments.
 * Empty or blank argument values are treated as not provided.
 *
 * @returns {Object}
 */
function getArguments() {
  const options = { ...DEFAULT_OPTIONS };
  if (typeof $argument !== "string" || !$argument) {
    return options;
  }

  const runtimeArgs = parseArguments($argument);

  for (const [key, value] of Object.entries(runtimeArgs)) {
    // Treat empty/blank as not provided.
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    options[key] = value;
  }

  options.timeout = normalizeTimeout(options.timeout);
  return options;
}

/**
 * Normalize timeout in milliseconds.
 *
 * @param {string|number|undefined} timeout
 * @returns {number}
 */
function normalizeTimeout(timeout) {
  const parsedTimeout = Number(timeout);
  if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) {
    return parsedTimeout;
  }
  console.log(
    `[${SCRIPT_NAME}] normalizeTimeout: event=invalid_timeout, raw=${timeout}, fallback=${DEFAULT_OPTIONS.timeout}`,
  );
  return DEFAULT_OPTIONS.timeout;
}

/**
 * Replace region placeholders in content template.
 *
 * @param {string} content
 * @param {string} region
 * @param {string} warpStatus
 * @returns {string}
 */
function replaceRegionPlaceholder(
  content,
  region,
  warpStatus = WARP_STATUS_UNKNOWN,
) {
  let result = content;
  const regionCode = (region || "").toUpperCase();
  const regionInfo = SUPPORTED_REGIONS[regionCode];
  const normalizedWarpStatus =
    typeof warpStatus === "string" && warpStatus
      ? warpStatus
      : WARP_STATUS_UNKNOWN;

  if (result.includes("#REGION_CODE#")) {
    result = result.replaceAll("#REGION_CODE#", regionCode);
  }
  if (result.includes("#REGION_FLAG#")) {
    result = result.replaceAll(
      "#REGION_FLAG#",
      getCountryFlagEmoji(regionCode),
    );
  }
  if (result.includes("#REGION_NAME#")) {
    result = result.replaceAll(
      "#REGION_NAME#",
      (regionInfo?.chinese ?? regionCode) || "Unknown",
    );
  }
  if (result.includes("#REGION_NAME_EN#")) {
    result = result.replaceAll(
      "#REGION_NAME_EN#",
      (regionInfo?.english ?? regionCode) || "Unknown",
    );
  }
  if (result.includes("#WARP_STATUS#")) {
    result = result.replaceAll("#WARP_STATUS#", normalizedWarpStatus);
  }

  return result;
}
