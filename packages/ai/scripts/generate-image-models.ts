#!/usr/bin/env node

// generate-image-models.ts — 纯本地,零联网。
//
// 公司内部项目:image-models.generated.ts 是已提交的本地订阅源(图片模型
// catalog)。本脚本不再联网拉 OpenRouter,只确认产物存在并保留。
//
// 历史问题:旧版本联网 fetch OpenRouter 图片模型,失败时返回空数组 →
// 覆盖出一个空的 image-models.generated.ts。改为保留已提交的产物。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

function main(): void {
	const outPath = join(packageRoot, "src", "image-models.generated.ts");
	if (!existsSync(outPath)) {
		throw new Error(
			`Missing ${outPath}. ` +
				"image-models.generated.ts is the local subscription source and must be committed.",
		);
	}
	// 保留已提交的产物,不联网覆盖。
	console.log(`Kept existing ${outPath} (local subscription source, no network)`);
}

main();
