/**
 * 「启动器操作」（UI 自动化）总开关。
 *
 * 刻意与文件权限解耦：文件权限管的是「能不能读写文件」，这里管的是
 * 「能不能动启动器界面」。两者权限模型、风险面、用户心理预期都不同，
 * 塞进同一个三档开关只会让人困惑。
 *
 * 单独放一个小模块而不是塞进 engine，是因为 handler 层也要读它；
 * engine → handlers 已是单向依赖，若 handlers 反过来 import engine 会成环。
 */
let enabled = false

export function setUiControlEnabled(v: boolean) {
  enabled = v === true
}

export function isUiControlEnabled(): boolean {
  return enabled
}
