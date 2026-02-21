/*
https://gist.githubusercontent.com/Hyseen/5ae36a6a5cb5690b1f2bff4aa19c766f/raw/youtube_premium_check.js
https://raw.githubusercontent.com/dler-io/Rules/refs/heads/main/Surge/Surge%204/Script/youtube_check.js

- - - - - - - - - - - - - - - - - - - - -

可选参数 (参数值中的空格请使用 "+" 替代):

title: 面板标题

availableContent: 支持时展示的文本内容, 支持占位符 #REGION_FLAG# #REGION_CODE# #REGION_NAME# #REGION_NAME_EN#, 分别对应地区国旗 地区编码 地区中文名称 地区英文名称

availableIcon: 解锁时展示的图标, 内容为任意有效的 SF Symbol Name

availableIconColor: 解锁时展示的图标颜色, 内容为颜色的 HEX 编码

availableStyle: 解锁时展示的样式, 参数可选值有 good, info, alert, error. 注意相应的 Icon / Color 会覆盖此设置

notAvailableContent: 不支持解锁时展示的文本内容

notAvailableIcon: 不支持解锁时展示的图标

notAvailableIconColor: 不支持解锁时展示的图标颜色

notAvailableStyle: 不支持解锁时展示的样式, 参数可选值有 good, info, alert, error. 注意相应的 Icon / Color 会覆盖此设置

errorContent: 检测异常时展示的文本内容

errorIcon: 检测异常时展示的图标

errorIconColor: 检测异常时展示的图标颜色

errorStyle: 检测异常时展示的样式, 参数可选值有 good, info, alert, error. 注意相应的 Icon / Color 会覆盖此设置

timeout: 检测超时时间, 单位毫秒, 默认 5000

- - - - - - -

Surge 使用示例:

[Panel]
nf_check = script-name=nf_check, title="Youtube 解锁检测", content="请刷新", update-interval=1

[Script]
nf_check = type=generic, timeout=30, script-path=https://raw.githubusercontent.com/iCasture/Proxy-Rules/refs/heads/master/Surge/Scripts/youtube_check.js, argument=title=Youtube+解锁检测

注意: Surge 本身的 timout 参数需要设置的稍长一点, 防止脚本在输出结果前就被 Surge 中断, 导致无输出. 由于脚本本身自带了超时处理功能, 因此无须担心网络异常导致的长时间卡死问题.

如果需要修改超时控制相关逻辑, 请使用脚本自带的参数.

- - - - - - -

Debug:

Surge 的 [Script] 支持 debug 参数. 设为 true 后可启用调试模式:

1. Surge Mac 会在每次执行前从文件系统重新加载脚本.
2. 对于 http-request / http-response 脚本, `console.log()` 也会出现在请求备注中.

示例：

[Panel]
nf_check = script-name=nf_check, title="Youtube 解锁检测", content="请刷新", update-interval=1

[Script]
nf_check = type=generic, script-path=https://raw.githubusercontent.com/iCasture/Proxy-Rules/refs/heads/master/Surge/Scripts/youtube_check.js, argument=title=Youtube+解锁检测, debug=true
*/

const BASE_URL = "https://www.youtube.com/premium";
const PREMIUM_UNAVAILABLE_MARKER = "Premium is not available in your country";
const GOOGLE_CN_MARKER = "www.google.cn";
const COUNTRY_CODE_PATTERN = /"countryCode":"(.*?)"/;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36";
const SCRIPT_NAME = "youtube_check";

const STATUS_AVAILABLE = "available";
const STATUS_NOT_AVAILABLE = "not_available";
const STATUS_TIMEOUT = "timeout";
const STATUS_ERROR = "error";

const ERROR_NOT_AVAILABLE = "probe_not_available";
const ERROR_TIMEOUT = "network_timeout";
const ERROR_GENERIC = "network_error";

const DEFAULT_OPTIONS = {
  title: "YouTube Premium",
  availableContent: "支持 | 地区: #REGION_FLAG# #REGION_NAME#",
  availableIcon: "",
  availableIconColor: "",
  availableStyle: "good",
  notAvailableContent: "不支持",
  notAvailableIcon: "",
  notAvailableIconColor: "",
  notAvailableStyle: "alert",
  errorContent: "检测失败, 请重试",
  errorIcon: "",
  errorIconColor: "",
  errorStyle: "error",
  timeout: 5000,
};

// https://www.iso.org/iso-3166-country-codes.html
// https://datahub.io/core/country-list#data
// https://www.iso.org/obp/ui/#search/code/
// https://datahub.io/core/country-list/r/data.csv
const REGION_NAMES = {
  AD: { chinese: "安道尔", english: "Andorra" },
  AE: { chinese: "阿拉伯联合酋长国", english: "United Arab Emirates" },
  AF: { chinese: "阿富汗", english: "Afghanistan" },
  AG: { chinese: "安提瓜和巴布达", english: "Antigua and Barbuda" },
  AI: { chinese: "安圭拉", english: "Anguilla" },
  AL: { chinese: "阿尔巴尼亚", english: "Albania" },
  AM: { chinese: "亚美尼亚", english: "Armenia" },
  AO: { chinese: "安哥拉", english: "Angola" },
  AQ: { chinese: "南极洲", english: "Antarctica" },
  AR: { chinese: "阿根廷", english: "Argentina" },
  AS: { chinese: "美属萨摩亚", english: "American Samoa" },
  AT: { chinese: "奥地利", english: "Austria" },
  AU: { chinese: "澳大利亚", english: "Australia" },
  AW: { chinese: "阿鲁巴", english: "Aruba" },
  AX: { chinese: "奥兰群岛", english: "land Islands" },
  AZ: { chinese: "阿塞拜疆", english: "Azerbaijan" },
  BA: { chinese: "波斯尼亚和黑塞哥维那", english: "Bosnia and Herzegovina" },
  BB: { chinese: "巴巴多斯", english: "Barbados" },
  BD: { chinese: "孟加拉国", english: "Bangladesh" },
  BE: { chinese: "比利时", english: "Belgium" },
  BF: { chinese: "布基纳法索", english: "Burkina Faso" },
  BG: { chinese: "保加利亚", english: "Bulgaria" },
  BH: { chinese: "巴林", english: "Bahrain" },
  BI: { chinese: "布隆迪", english: "Burundi" },
  BJ: { chinese: "贝宁", english: "Benin" },
  BL: { chinese: "圣巴泰勒米", english: "Saint BarthÃ©lemy" },
  BM: { chinese: "百慕大", english: "Bermuda" },
  BN: { chinese: "文莱", english: "Brunei Darussalam" },
  BO: { chinese: "玻利维亚", english: "Bolivia, Plurinational State of" },
  BQ: { chinese: "荷属加勒比区", english: "Bonaire, Sint Eustatius and Saba" },
  BR: { chinese: "巴西", english: "Brazil" },
  BS: { chinese: "巴哈马", english: "Bahamas" },
  BT: { chinese: "不丹", english: "Bhutan" },
  BV: { chinese: "布韦岛", english: "Bouvet Island" },
  BW: { chinese: "博茨瓦纳", english: "Botswana" },
  BY: { chinese: "白俄罗斯", english: "Belarus" },
  BZ: { chinese: "伯利兹", english: "Belize" },
  CA: { chinese: "加拿大", english: "Canada" },
  CC: { chinese: "科科斯（基林）群岛", english: "Cocos (Keeling) Islands" },
  CD: {
    chinese: "刚果（金）",
    english: "Congo, the Democratic Republic of the",
  },
  CF: { chinese: "中非共和国", english: "Central African Republic" },
  CG: { chinese: "刚果（布）", english: "Congo" },
  CH: { chinese: "瑞士", english: "Switzerland" },
  CI: { chinese: "科特迪瓦", english: "CÃ´te d'Ivoire" },
  CK: { chinese: "库克群岛", english: "Cook Islands" },
  CL: { chinese: "智利", english: "Chile" },
  CM: { chinese: "喀麦隆", english: "Cameroon" },
  CN: { chinese: "中国", english: "China" },
  CO: { chinese: "哥伦比亚", english: "Colombia" },
  CR: { chinese: "哥斯达黎加", english: "Costa Rica" },
  CU: { chinese: "古巴", english: "Cuba" },
  CV: { chinese: "佛得角", english: "Cape Verde" },
  CW: { chinese: "库拉索", english: "CuraÃ§ao" },
  CX: { chinese: "圣诞岛", english: "Christmas Island" },
  CY: { chinese: "塞浦路斯", english: "Cyprus" },
  CZ: { chinese: "捷克", english: "Czech Republic" },
  DE: { chinese: "德国", english: "Germany" },
  DJ: { chinese: "吉布提", english: "Djibouti" },
  DK: { chinese: "丹麦", english: "Denmark" },
  DM: { chinese: "多米尼克", english: "Dominica" },
  DO: { chinese: "多米尼加共和国", english: "Dominican Republic" },
  DZ: { chinese: "阿尔及利亚", english: "Algeria" },
  EC: { chinese: "厄瓜多尔", english: "Ecuador" },
  EE: { chinese: "爱沙尼亚", english: "Estonia" },
  EG: { chinese: "埃及", english: "Egypt" },
  EH: { chinese: "西撒哈拉", english: "Western Sahara" },
  ER: { chinese: "厄立特里亚", english: "Eritrea" },
  ES: { chinese: "西班牙", english: "Spain" },
  ET: { chinese: "埃塞俄比亚", english: "Ethiopia" },
  FI: { chinese: "芬兰", english: "Finland" },
  FJ: { chinese: "斐济", english: "Fiji" },
  FK: { chinese: "福克兰群岛", english: "Falkland Islands (Malvinas)" },
  FM: { chinese: "密克罗尼西亚", english: "Micronesia, Federated States of" },
  FO: { chinese: "法罗群岛", english: "Faroe Islands" },
  FR: { chinese: "法国", english: "France" },
  GA: { chinese: "加蓬", english: "Gabon" },
  GB: { chinese: "英国", english: "United Kingdom" },
  GD: { chinese: "格林纳达", english: "Grenada" },
  GE: { chinese: "格鲁吉亚", english: "Georgia" },
  GF: { chinese: "法属圭亚那", english: "French Guiana" },
  GG: { chinese: "根西岛", english: "Guernsey" },
  GH: { chinese: "加纳", english: "Ghana" },
  GI: { chinese: "直布罗陀", english: "Gibraltar" },
  GL: { chinese: "格陵兰", english: "Greenland" },
  GM: { chinese: "冈比亚", english: "Gambia" },
  GN: { chinese: "几内亚", english: "Guinea" },
  GP: { chinese: "瓜德罗普", english: "Guadeloupe" },
  GQ: { chinese: "赤道几内亚", english: "Equatorial Guinea" },
  GR: { chinese: "希腊", english: "Greece" },
  GS: {
    chinese: "南乔治亚和南桑威奇群岛",
    english: "South Georgia and the South Sandwich Islands",
  },
  GT: { chinese: "危地马拉", english: "Guatemala" },
  GU: { chinese: "关岛", english: "Guam" },
  GW: { chinese: "几内亚比绍", english: "Guinea-Bissau" },
  GY: { chinese: "圭亚那", english: "Guyana" },
  HK: { chinese: "中国香港", english: "Hong Kong" },
  HM: {
    chinese: "赫德岛和麦克唐纳群岛",
    english: "Heard Island and McDonald Islands",
  },
  HN: { chinese: "洪都拉斯", english: "Honduras" },
  HR: { chinese: "克罗地亚", english: "Croatia" },
  HT: { chinese: "海地", english: "Haiti" },
  HU: { chinese: "匈牙利", english: "Hungary" },
  ID: { chinese: "印度尼西亚", english: "Indonesia" },
  IE: { chinese: "爱尔兰", english: "Ireland" },
  IL: { chinese: "以色列", english: "Israel" },
  IM: { chinese: "马恩岛", english: "Isle of Man" },
  IN: { chinese: "印度", english: "India" },
  IO: { chinese: "英属印度洋领地", english: "British Indian Ocean Territory" },
  IQ: { chinese: "伊拉克", english: "Iraq" },
  IR: { chinese: "伊朗", english: "Iran, Islamic Republic of" },
  IS: { chinese: "冰岛", english: "Iceland" },
  IT: { chinese: "意大利", english: "Italy" },
  JE: { chinese: "泽西岛", english: "Jersey" },
  JM: { chinese: "牙买加", english: "Jamaica" },
  JO: { chinese: "约旦", english: "Jordan" },
  JP: { chinese: "日本", english: "Japan" },
  KE: { chinese: "肯尼亚", english: "Kenya" },
  KG: { chinese: "吉尔吉斯斯坦", english: "Kyrgyzstan" },
  KH: { chinese: "柬埔寨", english: "Cambodia" },
  KI: { chinese: "基里巴斯", english: "Kiribati" },
  KM: { chinese: "科摩罗", english: "Comoros" },
  KN: { chinese: "圣基茨和尼维斯", english: "Saint Kitts and Nevis" },
  KP: { chinese: "朝鲜", english: "Korea, Democratic People's Republic of" },
  KR: { chinese: "韩国", english: "Korea, Republic of" },
  KW: { chinese: "科威特", english: "Kuwait" },
  KY: { chinese: "开曼群岛", english: "Cayman Islands" },
  KZ: { chinese: "哈萨克斯坦", english: "Kazakhstan" },
  LA: { chinese: "老挝", english: "Lao People's Democratic Republic" },
  LB: { chinese: "黎巴嫩", english: "Lebanon" },
  LC: { chinese: "圣卢西亚", english: "Saint Lucia" },
  LI: { chinese: "列支敦士登", english: "Liechtenstein" },
  LK: { chinese: "斯里兰卡", english: "Sri Lanka" },
  LR: { chinese: "利比里亚", english: "Liberia" },
  LS: { chinese: "莱索托", english: "Lesotho" },
  LT: { chinese: "立陶宛", english: "Lithuania" },
  LU: { chinese: "卢森堡", english: "Luxembourg" },
  LV: { chinese: "拉脱维亚", english: "Latvia" },
  LY: { chinese: "利比亚", english: "Libya" },
  MA: { chinese: "摩洛哥", english: "Morocco" },
  MC: { chinese: "摩纳哥", english: "Monaco" },
  MD: { chinese: "摩尔多瓦", english: "Moldova, Republic of" },
  ME: { chinese: "黑山", english: "Montenegro" },
  MF: { chinese: "法属圣马丁", english: "Saint Martin (French part)" },
  MG: { chinese: "马达加斯加", english: "Madagascar" },
  MH: { chinese: "马绍尔群岛", english: "Marshall Islands" },
  MK: {
    chinese: "北马其顿",
    english: "Macedonia, the Former Yugoslav Republic of",
  },
  ML: { chinese: "马里", english: "Mali" },
  MM: { chinese: "缅甸", english: "Myanmar" },
  MN: { chinese: "蒙古", english: "Mongolia" },
  MO: { chinese: "中国澳门", english: "Macao" },
  MP: { chinese: "北马里亚纳群岛", english: "Northern Mariana Islands" },
  MQ: { chinese: "马提尼克", english: "Martinique" },
  MR: { chinese: "毛里塔尼亚", english: "Mauritania" },
  MS: { chinese: "蒙特塞拉特", english: "Montserrat" },
  MT: { chinese: "马耳他", english: "Malta" },
  MU: { chinese: "毛里求斯", english: "Mauritius" },
  MV: { chinese: "马尔代夫", english: "Maldives" },
  MW: { chinese: "马拉维", english: "Malawi" },
  MX: { chinese: "墨西哥", english: "Mexico" },
  MY: { chinese: "马来西亚", english: "Malaysia" },
  MZ: { chinese: "莫桑比克", english: "Mozambique" },
  NA: { chinese: "纳米比亚", english: "Namibia" },
  NC: { chinese: "新喀里多尼亚", english: "New Caledonia" },
  NE: { chinese: "尼日尔", english: "Niger" },
  NF: { chinese: "诺福克岛", english: "Norfolk Island" },
  NG: { chinese: "尼日利亚", english: "Nigeria" },
  NI: { chinese: "尼加拉瓜", english: "Nicaragua" },
  NL: { chinese: "荷兰", english: "Netherlands" },
  NO: { chinese: "挪威", english: "Norway" },
  NP: { chinese: "尼泊尔", english: "Nepal" },
  NR: { chinese: "瑙鲁", english: "Nauru" },
  NU: { chinese: "纽埃", english: "Niue" },
  NZ: { chinese: "新西兰", english: "New Zealand" },
  OM: { chinese: "阿曼", english: "Oman" },
  PA: { chinese: "巴拿马", english: "Panama" },
  PE: { chinese: "秘鲁", english: "Peru" },
  PF: { chinese: "法属波利尼西亚", english: "French Polynesia" },
  PG: { chinese: "巴布亚新几内亚", english: "Papua New Guinea" },
  PH: { chinese: "菲律宾", english: "Philippines" },
  PK: { chinese: "巴基斯坦", english: "Pakistan" },
  PL: { chinese: "波兰", english: "Poland" },
  PM: { chinese: "圣皮埃尔和密克隆群岛", english: "Saint Pierre and Miquelon" },
  PN: { chinese: "皮特凯恩群岛", english: "Pitcairn" },
  PR: { chinese: "波多黎各", english: "Puerto Rico" },
  PS: { chinese: "巴勒斯坦领土", english: "Palestine, State of" },
  PT: { chinese: "葡萄牙", english: "Portugal" },
  PW: { chinese: "帕劳", english: "Palau" },
  PY: { chinese: "巴拉圭", english: "Paraguay" },
  QA: { chinese: "卡塔尔", english: "Qatar" },
  RE: { chinese: "留尼汪", english: "RÃ©union" },
  RO: { chinese: "罗马尼亚", english: "Romania" },
  RS: { chinese: "塞尔维亚", english: "Serbia" },
  RU: { chinese: "俄罗斯", english: "Russian Federation" },
  RW: { chinese: "卢旺达", english: "Rwanda" },
  SA: { chinese: "沙特阿拉伯", english: "Saudi Arabia" },
  SB: { chinese: "所罗门群岛", english: "Solomon Islands" },
  SC: { chinese: "塞舌尔", english: "Seychelles" },
  SD: { chinese: "苏丹", english: "Sudan" },
  SE: { chinese: "瑞典", english: "Sweden" },
  SG: { chinese: "新加坡", english: "Singapore" },
  SH: {
    chinese: "圣赫勒拿",
    english: "Saint Helena, Ascension and Tristan da Cunha",
  },
  SI: { chinese: "斯洛文尼亚", english: "Slovenia" },
  SJ: { chinese: "斯瓦尔巴和扬马延", english: "Svalbard and Jan Mayen" },
  SK: { chinese: "斯洛伐克", english: "Slovakia" },
  SL: { chinese: "塞拉利昂", english: "Sierra Leone" },
  SM: { chinese: "圣马力诺", english: "San Marino" },
  SN: { chinese: "塞内加尔", english: "Senegal" },
  SO: { chinese: "索马里", english: "Somalia" },
  SR: { chinese: "苏里南", english: "Suriname" },
  SS: { chinese: "南苏丹", english: "South Sudan" },
  ST: { chinese: "圣多美和普林西比", english: "Sao Tome and Principe" },
  SV: { chinese: "萨尔瓦多", english: "El Salvador" },
  SX: { chinese: "荷属圣马丁", english: "Sint Maarten (Dutch part)" },
  SY: { chinese: "叙利亚", english: "Syrian Arab Republic" },
  SZ: { chinese: "斯威士兰", english: "Eswatini" },
  TC: { chinese: "特克斯和凯科斯群岛", english: "Turks and Caicos Islands" },
  TD: { chinese: "乍得", english: "Chad" },
  TF: { chinese: "法属南部领地", english: "French Southern Territories" },
  TG: { chinese: "多哥", english: "Togo" },
  TH: { chinese: "泰国", english: "Thailand" },
  TJ: { chinese: "塔吉克斯坦", english: "Tajikistan" },
  TK: { chinese: "托克劳", english: "Tokelau" },
  TL: { chinese: "东帝汶", english: "Timor-Leste" },
  TM: { chinese: "土库曼斯坦", english: "Turkmenistan" },
  TN: { chinese: "突尼斯", english: "Tunisia" },
  TO: { chinese: "汤加", english: "Tonga" },
  TR: { chinese: "土耳其", english: "Turkey" },
  TT: { chinese: "特立尼达和多巴哥", english: "Trinidad and Tobago" },
  TV: { chinese: "图瓦卢", english: "Tuvalu" },
  TW: { chinese: "中国台湾", english: "Taiwan" },
  TZ: { chinese: "坦桑尼亚", english: "Tanzania, United Republic of" },
  UA: { chinese: "乌克兰", english: "Ukraine" },
  UG: { chinese: "乌干达", english: "Uganda" },
  UM: {
    chinese: "美国本土外小岛屿",
    english: "United States Minor Outlying Islands",
  },
  US: { chinese: "美国", english: "United States of America" },
  UY: { chinese: "乌拉圭", english: "Uruguay" },
  UZ: { chinese: "乌兹别克斯坦", english: "Uzbekistan" },
  VA: { chinese: "梵蒂冈", english: "Holy See (Vatican City State)" },
  VC: {
    chinese: "圣文森特和格林纳丁斯",
    english: "Saint Vincent and the Grenadines",
  },
  VE: { chinese: "委内瑞拉", english: "Venezuela, Bolivarian Republic of" },
  VG: { chinese: "英属维尔京群岛", english: "Virgin Islands, British" },
  VI: { chinese: "美属维尔京群岛", english: "Virgin Islands, U.S." },
  VN: { chinese: "越南", english: "Viet Nam" },
  VU: { chinese: "瓦努阿图", english: "Vanuatu" },
  WF: { chinese: "瓦利斯和富图纳", english: "Wallis and Futuna" },
  WS: { chinese: "萨摩亚", english: "Samoa" },
  YE: { chinese: "也门", english: "Yemen" },
  YT: { chinese: "马约特", english: "Mayotte" },
  ZA: { chinese: "南非", english: "South Africa" },
  ZM: { chinese: "赞比亚", english: "Zambia" },
  ZW: { chinese: "津巴布韦", english: "Zimbabwe" },
};

const options = getArguments();
const panel = {
  title: options.title,
};

(async () => {
  const { region, status } = await testYouTube();
  console.log(
    `[${SCRIPT_NAME}] testYouTube: region=${region}, status=${status}`,
  );
  setPanelByStatus(panel, options, status, region);
})()
  .catch((error) => {
    console.log(`[${SCRIPT_NAME}] main: error=${error}`);
    setPanelByStatus(panel, options, STATUS_ERROR, "");
  })
  .finally(() => {
    $done(panel);
  });

/**
 * Run YouTube Premium probe and map result to status.
 *
 * @returns {Promise<{region?: string, status: string}>}
 */
async function testYouTube() {
  try {
    const region = await withTimeout(probeYouTubePremium(), options.timeout);
    return { region, status: STATUS_AVAILABLE };
  } catch (error) {
    console.log(`[${SCRIPT_NAME}] testYouTube: error=${error}`);
    if (error === ERROR_NOT_AVAILABLE) {
      return { status: STATUS_NOT_AVAILABLE };
    }
    if (error === ERROR_TIMEOUT) {
      return { status: STATUS_TIMEOUT };
    }
    return { status: STATUS_ERROR };
  }
}

/**
 * Probe YouTube Premium availability and return region code.
 *
 * @returns {Promise<string>} Two-letter region code.
 */
function probeYouTubePremium() {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      url: BASE_URL,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en",
      },
    };
    $httpClient.get(requestOptions, (error, response, data) => {
      if (error != null || response.status !== 200) {
        console.log(
          `[${SCRIPT_NAME}] probeYouTubePremium: requestError=${error}, status=${response?.status}`,
        );
        reject(ERROR_GENERIC);
        return;
      }

      if (data.includes(PREMIUM_UNAVAILABLE_MARKER)) {
        console.log(
          `[${SCRIPT_NAME}] probeYouTubePremium: marker=PREMIUM_UNAVAILABLE_MARKER, reason=not_available`,
        );
        reject(ERROR_NOT_AVAILABLE);
        return;
      }

      let region = "";
      const result = COUNTRY_CODE_PATTERN.exec(data);
      if (result != null && result.length === 2) {
        region = result[1];
      } else if (data.includes(GOOGLE_CN_MARKER)) {
        region = "CN";
      } else {
        region = "US";
      }
      resolve(region.toUpperCase());
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
 * Set panel appearance and content by unified status constants.
 *
 * @param {Object} targetPanel
 * @param {Object} parsedOptions
 * @param {string} status
 * @param {string} region
 */
function setPanelByStatus(targetPanel, parsedOptions, status, region) {
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
      );
      return;
    case STATUS_NOT_AVAILABLE:
      applyIconOrStyle(
        targetPanel,
        parsedOptions.notAvailableIcon,
        parsedOptions.notAvailableIconColor,
        parsedOptions.notAvailableStyle,
      );
      targetPanel["content"] = parsedOptions.notAvailableContent;
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
  // if (!/^[A-Za-z]{2}$/.test(countryCode)) return "❓";

  let code = countryCode.toUpperCase();
  if (code === "TW") code = "CN";

  if (!REGION_NAMES[code]) return "❓";

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
 * @returns {string}
 */
function replaceRegionPlaceholder(content, region) {
  let result = content;
  const regionCode = (region || "").toUpperCase();
  const regionInfo = REGION_NAMES[regionCode];

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

  return result;
}
