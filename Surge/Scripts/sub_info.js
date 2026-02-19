/*
https://raw.githubusercontent.com/mieqq/mieqq/master/sub_info_panel.js
https://raw.githubusercontent.com/dler-io/Rules/refs/heads/main/Surge/Surge%204/Script/sub_info_panel.js

- - - - - - -

可选参数 (参数值中的空格请使用 "+" 替代):

url: 订阅链接 (必填). 注意需要对其进行 URL encode

title: 面板标题

reset_day: 流量每月重置日

        例如 "&reset_day=1" 表示每月 1 日重置, "&reset_day=15" 表示每月 15 日重置

        不加该参数不显示流量重置信息

expire: 手动指定到期时间 (优先级高于订阅返回)

        其值需要是 yyyy-MM-dd 格式或 Unix 时间戳 (秒或毫秒), 例如 "&expire=2022-02-01"

        若不希望显示到期信息，可设置为 "&expire=false" 取消显示

method: 请求方式

        可选值为 head 或 get (其他值会自动回退为 head), 默认为 head

        部分服务端不支持 HEAD 方式访问, 此时可添加参数 "&method=get" 指定为 GET 方式访问

timeout: 检测超时时间, 单位毫秒, 默认 5000

successIcon: 检测成功时展示的图标, 内容为任意有效的 SF Symbol Name

successIconColor: 检测成功时展示的图标颜色, 内容为颜色的 HEX 编码

successStyle: 检测成功时展示的样式, 参数可选值有 good, info, alert, error. 注意相应的 Icon / Color 会覆盖此设置

failureContent: 检测失败时展示的文本内容

failureIcon: 检测失败时展示的图标, 内容为任意有效的 SF Symbol Name

failureIconColor: 检测失败时展示的图标颜色, 内容为颜色的 HEX 编码

failureStyle: 检测失败时展示的样式, 参数可选值有 good, info, alert, error. 注意相应的 Icon / Color 会覆盖此设置

- - - - - - -

Surge 使用示例:

[Panel]
sub_info = script-name=sub_info, title="订阅信息", content="请刷新", update-interval=1

[Script]
sub_info = type=generic, timeout=30, script-path=https://raw.githubusercontent.com/iCasture/Proxy-Rules/refs/heads/master/Surge/Scripts/sub_info.js, script-update-interval=0, argument=url=[URL encode 后的机场节点链接]&title=AmyInfo&reset_day=1&timeout=10000&method=head&successIcon=network.badge.shield.half.filled&successIconColor=#32CD32&failureIcon=network.badge.shield.half.filled&failureIconColor=#FF0000

注意: Surge 本身的 timout 参数需要设置的稍长一点, 防止脚本在输出结果前就被 Surge 中断, 导致无输出. 由于脚本本身自带了超时处理功能, 因此无须担心网络异常导致的长时间卡死问题.

如果需要修改超时控制相关逻辑, 请使用脚本自带的参数.

- - - - - - -

Debug:

Surge 的 [Script] 支持 debug 参数. 设为 true 后可启用调试模式:

1. Surge Mac 会在每次执行前从文件系统重新加载脚本.
2. 对于 http-request / http-response 脚本, `console.log()` 也会出现在请求备注中.

示例：

[Panel]
sub_info = script-name=sub_info, title="订阅信息", content="请刷新", update-interval=1

[Script]
sub_info = type=generic, timeout=30, script-path=https://raw.githubusercontent.com/iCasture/Proxy-Rules/refs/heads/master/Surge/Scripts/sub_info.js, script-update-interval=0, argument=url=[URL encode 后的机场节点链接]&title=AmyInfo&reset_day=1&timeout=10000&method=head&successIcon=network.badge.shield.half.filled&successIconColor=#32CD32&failureIcon=network.badge.shield.half.filled&failureIconColor=#FF0000o, debug=true
*/

const SCRIPT_NAME = "sub_info";

const ERROR_TIMEOUT = "network_timeout";
const ERROR_GENERIC = "unknown_error";
const ERROR_MISSING_URL = "missing_url";
const ERROR_REQUEST_FAILED = "request_failed";
const ERROR_MISSING_HEADER = "missing_header";
const ERROR_INVALID_HEADER_FORMAT = "invalid_header_format";
const ERROR_MISSING_TRAFFIC_FIELDS = "missing_traffic_fields";

const STATUS_SUCCESS = "success";
const STATUS_TIMEOUT = "timeout";
const STATUS_ERROR = "error";

const REQUIRED_TRAFFIC_FIELDS = ["download", "upload", "total"];
const SUBSCRIPTION_HEADER_NAME = "subscription-userinfo";

const DEFAULT_OPTIONS = {
  title: "Subscription Info",
  method: "head",
  timeout: 5000,
  // successIcon: "airplane.circle",
  successIcon: "network.badge.shield.half.filled",
  successIconColor: "#16A951",
  successStyle: "good",
  failureContent: "获取订阅信息失败, 请检查配置",
  failureIcon: undefined,
  failureIconColor: undefined,
  failureStyle: "error",
};

const options = getArguments();
const panel = {
  title: options.title,
};

(async () => {
  const { status, subscriptionInfo, errorInfo } =
    await resolveSubscriptionPanelStatus();
  if (status === STATUS_SUCCESS) {
    console.log(
      `[${SCRIPT_NAME}] main: event=fetch_success, method=${normalizeHttpMethod(options.method)}, timeout=${options.timeout}`,
    );
    setPanelByStatus(panel, options, status, subscriptionInfo, undefined);
  } else {
    console.log(
      `[${SCRIPT_NAME}] main: event=fetch_failed, status=${status}, method=${normalizeHttpMethod(options.method)}, timeout=${options.timeout}, code=${errorInfo?.code}, message="${errorInfo?.message}"`,
    );
    setPanelByStatus(panel, options, status, undefined, errorInfo);
  }
})()
  .catch((error) => {
    const normalizedError = normalizeError(error);
    console.log(
      `[${SCRIPT_NAME}] main: event=unexpected_error, status=${STATUS_ERROR}, method=${normalizeHttpMethod(options.method)}, timeout=${options.timeout}, code=${normalizedError.code}, message="${normalizedError.message}"`,
    );
    setPanelByStatus(panel, options, STATUS_ERROR, undefined, normalizedError);
  })
  .finally(() => {
    $done(panel);
  });

/**
 * Resolve panel status from subscription data and errors.
 *
 * @returns {Promise<{status: string, subscriptionInfo?: {download: number, upload: number, total: number, expire?: string}, errorInfo?: {code: string, message: string, statusCode?: number, missingHeaders?: string[], missingFields?: string[]}}>}
 */
async function resolveSubscriptionPanelStatus() {
  try {
    const subscriptionInfo = await loadSubscriptionInfo(options.url);
    return { status: STATUS_SUCCESS, subscriptionInfo };
  } catch (error) {
    const errorInfo = normalizeError(error);
    const status =
      errorInfo.code === ERROR_TIMEOUT ? STATUS_TIMEOUT : STATUS_ERROR;
    return { status, errorInfo };
  }
}

/**
 * Load subscription info from remote endpoint.
 *
 * @param {string} url
 * @returns {Promise<{download: number, upload: number, total: number, expire?: string}>}
 */
async function loadSubscriptionInfo(url) {
  if (!url) {
    throw createError(ERROR_MISSING_URL, "Missing required argument: url");
  }
  const headerValue = await withTimeout(
    fetchSubscriptionUserInfoHeader(url),
    options.timeout,
  );
  return parseSubscriptionUserInfoHeader(headerValue);
}

/**
 * Normalizes and validates HTTP method for $httpClient calls.
 *
 * @param {string|undefined} method - Method passed via script arguments.
 * @returns {"get"|"head"} A safe method supported by this script.
 */
function normalizeHttpMethod(method) {
  const normalized = String(method || "head").toLowerCase();
  if (normalized === "get" || normalized === "head") {
    return normalized;
  }
  console.log(
    `[${SCRIPT_NAME}] normalizeHttpMethod: raw=${method}, unsupported=${normalized}, fallback=head`,
  );
  return "head";
}

/**
 * Fetch the raw `subscription-userinfo` header from URL.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
function fetchSubscriptionUserInfoHeader(url) {
  const method = normalizeHttpMethod(options.method);
  const request = {
    // headers: { "User-Agent": "Quantumult%20X" },
    headers: {
      "User-Agent":
        "clash.meta/1.19.20 mihomo/1.19.20 clash-verge/v2.4.7 Clash/v1.18.0",
    },
    url,
  };

  return new Promise((resolve, reject) => {
    $httpClient[method](request, (error, response) => {
      if (error) {
        console.log(
          `[${SCRIPT_NAME}] fetchSubscriptionUserInfoHeader: requestError=${error}, method=${method}`,
        );
        reject(createError(ERROR_REQUEST_FAILED, String(error)));
        return;
      }

      const statusCode = response?.status;
      if (statusCode !== 200) {
        const statusText =
          typeof statusCode === "number" ? String(statusCode) : "unknown";
        const message =
          typeof statusCode === "number"
            ? `Unexpected HTTP status code (${statusCode})`
            : "HTTP status code unavailable";
        console.log(
          `[${SCRIPT_NAME}] fetchSubscriptionUserInfoHeader: status=${statusText}, method=${method}`,
        );
        reject(
          createError(ERROR_REQUEST_FAILED, message, {
            statusCode: typeof statusCode === "number" ? statusCode : undefined,
          }),
        );
        return;
      }

      const responseHeaders = response?.headers || {};
      const headerKey = Object.keys(responseHeaders).find(
        (key) => key.toLowerCase() === "subscription-userinfo",
      );

      if (!headerKey) {
        const availableHeaderCount = Object.keys(responseHeaders).length;
        console.log(
          `[${SCRIPT_NAME}] fetchSubscriptionUserInfoHeader: missingHeader=${SUBSCRIPTION_HEADER_NAME}, availableHeaderCount=${availableHeaderCount}, method=${method}`,
        );
        reject(
          createError(
            ERROR_MISSING_HEADER,
            `Missing response header: ${SUBSCRIPTION_HEADER_NAME}`,
            { missingHeaders: [SUBSCRIPTION_HEADER_NAME] },
          ),
        );
        return;
      }

      const headerValue = String(responseHeaders[headerKey] || "").trim();
      if (!headerValue) {
        console.log(
          `[${SCRIPT_NAME}] fetchSubscriptionUserInfoHeader: emptyHeader=${SUBSCRIPTION_HEADER_NAME}, method=${method}`,
        );
        reject(
          createError(
            ERROR_INVALID_HEADER_FORMAT,
            `${SUBSCRIPTION_HEADER_NAME} is empty`,
          ),
        );
        return;
      }

      resolve(headerValue);
    });
  });
}

/**
 * Parse `subscription-userinfo` header data.
 *
 * @param {string} headerValue
 * @returns {{download: number, upload: number, total: number, expire?: string}}
 */
function parseSubscriptionUserInfoHeader(headerValue) {
  const normalizedPairs = Object.create(null);

  for (const item of headerValue.split(";")) {
    const normalizedItem = item.trim();
    if (!normalizedItem) continue;
    const separatorIndex = normalizedItem.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalizedItem.slice(0, separatorIndex).trim().toLowerCase();
    const value = normalizedItem.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;
    normalizedPairs[key] = value;
  }

  const missingTrafficFields = REQUIRED_TRAFFIC_FIELDS.filter(
    (field) => !(field in normalizedPairs),
  );
  if (missingTrafficFields.length > 0) {
    console.log(
      `[${SCRIPT_NAME}] parseSubscriptionUserInfoHeader: missingTrafficFields=${missingTrafficFields.join(",")}, header="${headerValue}"`,
    );
    throw createError(
      ERROR_MISSING_TRAFFIC_FIELDS,
      `Missing traffic fields in ${SUBSCRIPTION_HEADER_NAME}: ${missingTrafficFields.join(", ")}`,
      { missingFields: missingTrafficFields },
    );
  }

  const download = Number(normalizedPairs.download);
  const upload = Number(normalizedPairs.upload);
  const total = Number(normalizedPairs.total);

  if (![download, upload, total].every((value) => Number.isFinite(value))) {
    console.log(
      `[${SCRIPT_NAME}] parseSubscriptionUserInfoHeader: invalidNumbers, header=${headerValue}`,
    );
    throw createError(
      ERROR_INVALID_HEADER_FORMAT,
      `Invalid number values in ${SUBSCRIPTION_HEADER_NAME}`,
    );
  }

  return {
    download,
    upload,
    total,
    expire: normalizedPairs.expire,
  };
}

/**
 * Calculates the remaining days until the next reset day.
 *
 * @param {number} resetDay - The day of the month when the traffic resets.
 * @returns {number|undefined} The number of days remaining or undefined if resetDay is invalid.
 */
function getRemainingDays(resetDay) {
  if (!resetDay || isNaN(resetDay) || resetDay < 1 || resetDay > 31) {
    console.log(
      `[${SCRIPT_NAME}] getRemainingDays: event=invalid_reset_day, raw=${resetDay}, expected=1..31`,
    );
    return undefined;
  }

  const now = new Date();
  const today = now.getDate();
  const month = now.getMonth();
  const year = now.getFullYear();
  let daysInMonth;

  if (resetDay > today) {
    daysInMonth = 0;
  } else {
    // Get total days in the current month
    daysInMonth = new Date(year, month + 1, 0).getDate();
  }

  return daysInMonth - today + resetDay;
}

/**
 * Build panel content for success status.
 *
 * @param {{download: number, upload: number, total: number, expire?: string}} subscriptionInfo
 * @param {Object} parsedOptions
 * @returns {string}
 */
function buildSuccessContent(subscriptionInfo, parsedOptions) {
  const used = subscriptionInfo.download + subscriptionInfo.upload;
  const total = subscriptionInfo.total;
  const remaining = Math.max(total - used, 0);
  const resetDay = Number.parseInt(parsedOptions.reset_day, 10);
  const daysUntilReset = getRemainingDays(resetDay);
  const expire = parsedOptions.expire || subscriptionInfo.expire;
  const daysUntilExpire = getDaysUntilExpire(expire);

  const contentLines = [
    `已用: ${bytesToSize(used)} / 可用: ${bytesToSize(remaining)}`,
    `总量: ${bytesToSize(total)}`,
  ];

  if (daysUntilReset) {
    contentLines.push(`重置: 剩余 ${daysUntilReset} 天`);
  }

  if (expire && expire !== "false") {
    const expireDateText = formatTime(expire);
    if (typeof daysUntilExpire === "number") {
      contentLines.push(`到期时间: ${expireDateText} (${daysUntilExpire} 天)`);
    } else {
      contentLines.push(`到期时间: ${expireDateText}`);
    }
  }

  contentLines.push(`更新时间: ${formatUpdateTime()}`);
  return contentLines.join("\n");
}

/**
 * Build panel content for error status.
 *
 * @param {{code: string, message: string, statusCode?: number, missingHeaders?: string[], missingFields?: string[]}} error
 * @returns {string}
 */
function buildErrorContent(error) {
  const contentLines = [options.failureContent];
  switch (error.code) {
    case ERROR_MISSING_URL:
      contentLines.push("原因: 缺少必填参数 (url)");
      break;
    case ERROR_TIMEOUT:
      contentLines.push(`原因: 请求超时 (${options.timeout} ms)`);
      break;
    case ERROR_MISSING_HEADER:
      contentLines.push(
        `原因: 缺少响应头 (${error.missingHeaders?.join(", ") || SUBSCRIPTION_HEADER_NAME})`,
      );
      break;
    case ERROR_MISSING_TRAFFIC_FIELDS:
      contentLines.push(
        `原因: ${SUBSCRIPTION_HEADER_NAME} 响应头缺少字段 (${error.missingFields?.join(", ") || REQUIRED_TRAFFIC_FIELDS.join(", ")})`,
      );
      break;
    case ERROR_REQUEST_FAILED:
      contentLines.push(
        `原因: HTTP 返回非预期状态码 (${error.statusCode ?? "未知"})`,
      );
      break;
    default:
      contentLines.push(`原因: ${error.message}`);
      break;
  }
  contentLines.push(`更新时间: ${formatUpdateTime()}`);
  return contentLines.join("\n");
}

/**
 * Normalize unknown errors to typed error object.
 *
 * @param {unknown} error
 * @returns {{code: string, message: string, statusCode?: number, missingHeaders?: string[], missingFields?: string[]}}
 */
function normalizeError(error) {
  if (error && typeof error === "object") {
    const maybeCode = /** @type {{code?: unknown}} */ (error).code;
    const maybeMessage = /** @type {{message?: unknown}} */ (error).message;
    if (typeof maybeCode === "string" && typeof maybeMessage === "string") {
      return /** @type {{code: string, message: string, statusCode?: number, missingHeaders?: string[], missingFields?: string[]}} */ (
        error
      );
    }
  }
  return createError(ERROR_GENERIC, String(error || "Unknown error"));
}

/**
 * Converts a byte value to a human-readable size string.
 *
 * @param {number} bytes - The number of bytes.
 * @returns {string} The formatted size string.
 */
function bytesToSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const k = 1024;
  const units = [
    "B",
    "KiB",
    "MiB",
    "GiB",
    "TiB",
    "PiB",
    "EiB",
    "ZiB",
    "YiB",
    "RiB",
    "QiB",
  ];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Formats a time value into a date string (yyyy 年 MM 月 dd 日).
 * Supports Unix timestamps (seconds or milliseconds) and date strings (e.g., yyyy-MM-dd).
 *
 * @param {number|string} time - The timestamp or date string.
 * @returns {string} The formatted date string.
 */
function formatTime(time) {
  const dateObj = parseDateInput(time);
  if (!dateObj) {
    console.log(
      `[${SCRIPT_NAME}] formatTime: event=invalid_expire_time, raw=${time}`,
    );
    return String(time);
  }
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth() + 1;
  const day = dateObj.getDate();
  return `${year} 年 ${month} 月 ${day} 日`;
}

/**
 * Parse date input to a Date object.
 * Supports Unix timestamps (seconds or milliseconds) and date strings.
 *
 * @param {number|string} time - The timestamp or date string.
 * @returns {Date | undefined} Parsed Date object, or `undefined` when invalid.
 */
function parseDateInput(time) {
  let normalizedTime = time;
  if (typeof normalizedTime === "string" && /^[\d.]+$/.test(normalizedTime)) {
    const parsedTimestamp = Number(normalizedTime);
    normalizedTime =
      parsedTimestamp < 1e12 ? parsedTimestamp * 1000 : parsedTimestamp;
  } else if (typeof normalizedTime === "number" && normalizedTime < 1e12) {
    normalizedTime *= 1000;
  }

  const dateObj = new Date(normalizedTime);
  if (isNaN(dateObj.getTime())) {
    return undefined;
  }
  return dateObj;
}

/**
 * Calculate remaining days until expire date.
 *
 * @param {number|string|undefined} expire - Expire date raw value.
 * @returns {number | undefined} Remaining days, or `undefined` when invalid.
 */
function getDaysUntilExpire(expire) {
  if (!expire || expire === "false") {
    return undefined;
  }

  const expireDate = parseDateInput(expire);
  if (!expireDate) {
    console.log(
      `[${SCRIPT_NAME}] getDaysUntilExpire: event=invalid_expire_time, raw=${expire}`,
    );
    return undefined;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const expireStart = new Date(
    expireDate.getFullYear(),
    expireDate.getMonth(),
    expireDate.getDate(),
  );

  const oneDayMs = 24 * 60 * 60 * 1000;
  const daysDiff = Math.round((expireStart.getTime() - todayStart.getTime()) / oneDayMs);
  return Math.max(daysDiff, 0);
}

/**
 * Format current time for panel update line.
 *
 * @returns {string}
 */
function formatUpdateTime() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const second = String(now.getSeconds()).padStart(2, "0");
  return `${year}.${month}.${day} ${hour}:${minute}:${second}`;
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
      reject(createError(ERROR_TIMEOUT, `Request timed out after ${delay} ms`));
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
 * Build a typed error object.
 *
 * @param {string} code
 * @param {string} message
 * @param {Object} [extra]
 * @returns {Object}
 */
function createError(code, message, extra = {}) {
  return {
    code,
    message,
    ...extra,
  };
}

/**
 * Set panel content and style by status.
 *
 * @param {Object} targetPanel
 * @param {Object} parsedOptions
 * @param {string} status
 * @param {{download: number, upload: number, total: number, expire?: string} | undefined} subscriptionInfo
 * @param {{code: string, message: string, statusCode?: number, missingHeaders?: string[], missingFields?: string[]} | undefined} errorInfo
 */
function setPanelByStatus(
  targetPanel,
  parsedOptions,
  status,
  subscriptionInfo,
  errorInfo,
) {
  if (status === STATUS_SUCCESS) {
    targetPanel.content = buildSuccessContent(subscriptionInfo, parsedOptions);
    applyIconOrStyle(
      targetPanel,
      parsedOptions.successIcon,
      parsedOptions.successIconColor,
      parsedOptions.successStyle,
    );
    return;
  }

  targetPanel.content = buildErrorContent(errorInfo);
  applyIconOrStyle(
    targetPanel,
    parsedOptions.failureIcon,
    parsedOptions.failureIconColor,
    parsedOptions.failureStyle,
  );
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
