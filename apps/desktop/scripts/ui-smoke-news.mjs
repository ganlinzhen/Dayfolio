#!/usr/bin/env node
// 保留发布流程的旧新闻验收入口，统一执行模块化新闻工作台的隔离验收。
// 新脚本使用临时数据库、HOME 和用户目录，以及模拟 Agent，不读取正式用户数据。
// TODODESK_SMOKE_APP 原样传递，兼容源码 Electron 与下载包中的正式 App。
await import('./ui-smoke-news-feed.mjs');
