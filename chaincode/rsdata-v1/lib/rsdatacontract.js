'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

// 工具方法：时间与序列化
function toBuffer(obj) {
    return Buffer.from(JSON.stringify(obj));
}

function parseBuffer(buf) {
    return JSON.parse(buf.toString());
}

function tsToISO(ts) {
    if (!ts) return null;
    const s = ts.seconds?.low ?? ts.seconds ?? 0;
    const n = ts.nanos ?? 0;
    return new Date(s * 1000 + Math.floor(n / 1e6)).toISOString();
}

// 使用 Fabric 交易时间戳，确保背书确定性
function txTimestamp(ctx) {
    const ts = ctx.stub.getTxTimestamp();
    const seconds = ts?.seconds?.low ?? ts?.seconds ?? 0;
    const nanos = ts?.nanos ?? 0;
    const millis = seconds * 1000 + Math.floor(nanos / 1e6);
    const iso = tsToISO(ts) || new Date(millis).toISOString();
    return { iso, seconds, nanos, millis };
}

// 文档类型常量
const DOC = {
    ASSET: 'ASSET',
    OWNER_LICENSE: 'OWNER_LICENSE',
    USAGE_LICENSE: 'USAGE_LICENSE',
    LINEAGE: 'LINEAGE'
};

// 状态常量
const STATUS = {
    ACTIVE: 'ACTIVE',
    REVOKED: 'REVOKED'
};

// PDC 配置：实际私有数据只分发给 collections_config.json 中授权的组织。
const PRIVATE_COLLECTION = 'rsAssetPrivateDataCollection';
const PRIVATE_TRANSIENT_KEY = 'asset_private_data';
const PRIVATE_DATA_MAX_BYTES = 64 * 1024;

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function containsCIDField(value) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(containsCIDField);

    return Object.entries(value).some(([key, child]) => {
        if (key.toLowerCase() === 'cid') return true;
        return containsCIDField(child);
    });
}



class RSDataContract extends Contract {

    _assertPrivateCollectionMember(ctx) {
        const mspId = ctx.clientIdentity.getMSPID();
        if (mspId !== 'Org1MSP' && mspId !== 'Org2MSP') {
            throw new Error(`组织 ${mspId} 不是 ${PRIVATE_COLLECTION} 的成员`);
        }
    }

    _parsePrivateAssetData(ctx, expectedAssetId) {
        this._assertPrivateCollectionMember(ctx);

        const transientMap = ctx.stub.getTransient();
        const privateBytes = transientMap && typeof transientMap.get === 'function'
            ? transientMap.get(PRIVATE_TRANSIENT_KEY)
            : null;

        if (!privateBytes || privateBytes.length === 0) {
            throw new Error(`缺少 transient 字段 ${PRIVATE_TRANSIENT_KEY}`);
        }
        if (privateBytes.length > PRIVATE_DATA_MAX_BYTES) {
            throw new Error(`私有资产信息超过 ${PRIVATE_DATA_MAX_BYTES} 字节限制`);
        }

        let input;
        try {
            input = JSON.parse(privateBytes.toString());
        } catch (_) {
            throw new Error(`transient 字段 ${PRIVATE_TRANSIENT_KEY} 必须是合法 JSON`);
        }

        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error('私有资产信息必须是 JSON 对象');
        }
        if (!input.CID || typeof input.CID !== 'string' || input.CID.trim().length === 0) {
            throw new Error('私有资产信息中的 CID 不能为空');
        }
        if (input.assetId && String(input.assetId) !== String(expectedAssetId)) {
            throw new Error('私有资产信息中的 assetId 与公共资产 assetId 不一致');
        }

        // 只写入经过规范化的确定性字段，避免将未声明字段意外带入 PDC。
        const privateRecord = {
            docType: 'ASSET_PRIVATE_DATA',
            assetId: String(expectedAssetId),
            CID: input.CID.trim(),
            sensitiveMetadata: input.sensitiveMetadata && typeof input.sensitiveMetadata === 'object'
                ? input.sensitiveMetadata
                : {}
        };
        const normalizedBytes = toBuffer(privateRecord);
        if (normalizedBytes.length > PRIVATE_DATA_MAX_BYTES) {
            throw new Error(`规范化后的私有资产信息超过 ${PRIVATE_DATA_MAX_BYTES} 字节限制`);
        }

        return { privateRecord, privateBytes: normalizedBytes };
    }

    _validatePublicAssetInput(asset) {
        if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
            throw new Error('资产信息必须是 JSON 对象');
        }
        if (containsCIDField(asset)) {
            throw new Error(`CID 不得作为公共资产参数提交，请通过 transient 字段 ${PRIVATE_TRANSIENT_KEY} 提交`);
        }
        if (Object.prototype.hasOwnProperty.call(asset, 'sensitiveMetadata')) {
            throw new Error(`sensitiveMetadata 不得写入公共状态，请通过 transient 字段 ${PRIVATE_TRANSIENT_KEY} 提交`);
        }
    }

    //获取调用者的 X509 身份标识（ctx.clientIdentity.getID()）
    getCallerCert(ctx) {
        const id = ctx.clientIdentity.getID();
        try { console.log(`[${ctx.stub.getTxID()}] getCallerCert -> ${id}`); } catch (_) { }
        return id;
    }

    //写入复合键占位记录（值使用空字节），便于 LevelDB 通过前缀高效查询
    async putIndex(ctx, objectType, attributes) {
        const key = ctx.stub.createCompositeKey(objectType, attributes);
        await ctx.stub.putState(key, Buffer.from('\u0000'));
        try { console.log(`[${ctx.stub.getTxID()}] putIndex type=${objectType} attrs=${JSON.stringify(attributes)} key=${key}`); } catch (_) { }
        return key;
    }

    //删除复合键占位记录
    async delIndex(ctx, objectType, attributes) {
        const key = ctx.stub.createCompositeKey(objectType, attributes);
        await ctx.stub.deleteState(key); // Fabric shim uses deleteState
        try { console.log(`[${ctx.stub.getTxID()}] delIndex type=${objectType} attrs=${JSON.stringify(attributes)} key=${key}`); } catch (_) { }
        return key;
    }

    //解析许可证：可通过 licenseId，或通过 assetId+enterpriseId 解析
    async resolveLicense(ctx, { licenseId, assetId, enterpriseId, docType }) {
        try { console.log(`[${ctx.stub.getTxID()}] resolveLicense input licenseId=${licenseId || ''} assetId=${assetId || ''} enterpriseId=${enterpriseId || ''} docType=${docType || ''}`); } catch (_) { }

        if (licenseId) {
            const raw = await ctx.stub.getState(String(licenseId));
            if (!raw || raw.length === 0) {
                throw new Error(`许可证 ${licenseId} 不存在`);
            }
            const licObj = parseBuffer(raw);
            if (docType && licObj.docType !== docType) {
                throw new Error(`许可证 ${licenseId} 类型不匹配`);
            }
            return { licId: String(licenseId), licObj };
        }

        if (!assetId || !enterpriseId) {
            throw new Error('需要提供 licenseId，或 assetId + enterpriseId 以解析许可证');
        }

        const wantOwner = !docType || docType === DOC.OWNER_LICENSE;
        const wantUsage = !docType || docType === DOC.USAGE_LICENSE;

        const ownerMatches = [];
        if (wantOwner) {
            const ownerIter = await ctx.stub.getStateByPartialCompositeKey('licenseOwner~enterpriseId', [enterpriseId, assetId]);
            while (true) {
                const res = await ownerIter.next();
                if (res.value) {
                    const split = ctx.stub.splitCompositeKey(res.value.key);
                    const candidateId = split.attributes[2];
                    const raw = await ctx.stub.getState(candidateId);
                    if (raw && raw.length > 0) {
                        const obj = parseBuffer(raw);
                        if (obj.docType === DOC.OWNER_LICENSE) ownerMatches.push({ licId: candidateId, licObj: obj });
                    }
                }
                if (res.done) break;
            }
        }

        const usageMatches = [];
        if (wantUsage) {
            const usageIter = await ctx.stub.getStateByPartialCompositeKey('licenseUse~enterpriseId', [enterpriseId, assetId]);
            while (true) {
                const res = await usageIter.next();
                if (res.value) {
                    const split = ctx.stub.splitCompositeKey(res.value.key);
                    const candidateId = split.attributes[2];
                    const raw = await ctx.stub.getState(candidateId);
                    if (raw && raw.length > 0) {
                        const obj = parseBuffer(raw);
                        if (obj.docType === DOC.USAGE_LICENSE) usageMatches.push({ licId: candidateId, licObj: obj });
                    }
                }
                if (res.done) break;
            }
        }

        if (docType === DOC.OWNER_LICENSE) {
            if (ownerMatches.length === 1) return ownerMatches[0];
            if (ownerMatches.length === 0) throw new Error(`未找到资产 ${assetId} 与企业 ${enterpriseId} 的所有权许可证`);
            throw new Error(`资产 ${assetId} 与企业 ${enterpriseId} 存在多个所有权许可证，请指定 licenseId`);
        }

        if (docType === DOC.USAGE_LICENSE) {
            if (usageMatches.length === 1) return usageMatches[0];
            if (usageMatches.length === 0) throw new Error(`未找到资产 ${assetId} 与企业 ${enterpriseId} 的使用许可证`);
            throw new Error(`资产 ${assetId} 与企业 ${enterpriseId} 存在多个使用许可证，请指定 licenseId`);
        }

        if (ownerMatches.length === 1 && usageMatches.length === 0) return ownerMatches[0];
        if (usageMatches.length === 1 && ownerMatches.length === 0) return usageMatches[0];
        if (ownerMatches.length === 0 && usageMatches.length === 0) {
            throw new Error(`未找到资产 ${assetId} 与企业 ${enterpriseId} 对应的许可证`);
        }
        throw new Error(`资产 ${assetId} 与企业 ${enterpriseId} 存在多个许可证，请指定 licenseId`);
    }



    // 判断企业是否拥有 ACTIVE 的所有者许可证
    async hasActiveOwnerLicense(ctx, enterpriseId, assetId) {
        try { console.log(`[${ctx.stub.getTxID()}] hasActiveOwnerLicense enterprise=${enterpriseId} asset=${assetId}`); } catch (_) { }
        const iter = await ctx.stub.getStateByPartialCompositeKey('licenseOwner~enterpriseId', [enterpriseId, assetId]);
        while (true) {
            const res = await iter.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const licenseId = split.attributes[2];
                const raw = await ctx.stub.getState(licenseId);
                if (raw && raw.length > 0) {
                    const lic = parseBuffer(raw);
                    if (lic.docType === DOC.OWNER_LICENSE && lic.status === STATUS.ACTIVE && lic.enterpriseId === enterpriseId) {
                        try { console.log(`[${ctx.stub.getTxID()}] hasActiveOwnerLicense -> true via ${licenseId}`); } catch (_) { }
                        //企业拥有 ACTIVE 所有者许可证
                        return true;
                    }
                }
            }
            if (res.done) break;
        }
        try { console.log(`[${ctx.stub.getTxID()}] hasActiveOwnerLicense -> false`); } catch (_) { }
        return false;
    }

    //判断企业是否拥有 ACTIVE 的使用许可证
    async hasActiveUsageLicense(ctx, enterpriseId, assetId) {
        try { console.log(`[${ctx.stub.getTxID()}] hasActiveUsageLicense enterprise=${enterpriseId} asset=${assetId}`); } catch (_) { }
        const iter = await ctx.stub.getStateByPartialCompositeKey('licenseUse~enterpriseId', [enterpriseId, assetId]);
        while (true) {
            const res = await iter.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const licenseId = split.attributes[2];
                const raw = await ctx.stub.getState(licenseId);
                if (raw && raw.length > 0) {
                    const lic = parseBuffer(raw);
                    if (lic.docType === DOC.USAGE_LICENSE && lic.status === STATUS.ACTIVE && lic.enterpriseId === enterpriseId) {
                        try { console.log(`[${ctx.stub.getTxID()}] hasActiveUsageLicense -> true via ${licenseId}`); } catch (_) { }
                        return true;
                    }
                }
            }
            if (res.done) break;
        }
        try { console.log(`[${ctx.stub.getTxID()}] hasActiveUsageLicense -> false`); } catch (_) { }
        return false;
    }

    //校验读权限（拥有者或使用者任一ACTIVE）
    async assertReadPermission(ctx, assetId) {
        const caller = this.getCallerCert(ctx);

        //用户读权限校验
        const profile = await this._checkComplianceRemote(ctx, caller, 'READ_ASSET', 0, '');

        const enterpriseId = profile?.enterpriseId;
        if (!enterpriseId) throw new Error('身份系统未返回企业信息，无法校验权限');

        //企业读权限校验:企业是否有资产的 ACTIVE 所有者许可证或使用许可证
        const owner = await this.hasActiveOwnerLicense(ctx, enterpriseId, assetId);
        if (owner) { try { console.log(`[${ctx.stub.getTxID()}] assertReadPermission -> granted as owner enterprise=${enterpriseId}`); } catch (_) { } return; }
        const usage = await this.hasActiveUsageLicense(ctx, enterpriseId, assetId);
        if (usage) { try { console.log(`[${ctx.stub.getTxID()}] assertReadPermission -> granted via usage enterprise=${enterpriseId}`); } catch (_) { } return; }
        try { console.log(`[${ctx.stub.getTxID()}] assertReadPermission -> denied`); } catch (_) { }
        throw new Error('无读权限：需要本企业拥有 ACTIVE 的所有者或使用许可证');
    }

    // 检查谱系图中从 startAssetId 是否可达 targetAssetId（防止循环）
    async _isReachable(ctx, startAssetId, targetAssetId) {
        if (!startAssetId || !targetAssetId) return false;
        if (startAssetId === targetAssetId) return true;

        const visited = new Set();
        const queue = [startAssetId];

        while (queue.length > 0) {
            const current = queue.shift();
            if (visited.has(current)) continue;
            visited.add(current);

            const iter = await ctx.stub.getStateByPartialCompositeKey('lineage~parentAssetId', [current]);
            while (true) {
                const res = await iter.next();
                if (res.value) {
                    const split = ctx.stub.splitCompositeKey(res.value.key);
                    const relationId = split.attributes[1];
                    const raw = await ctx.stub.getState(relationId);
                    if (raw && raw.length > 0) {
                        try {
                            const rel = parseBuffer(raw);
                            const childId = rel.childAssetId;
                            if (childId === targetAssetId) return true;
                            if (childId && !visited.has(childId)) queue.push(childId);
                        } catch (_) { }
                    }
                }
                if (res.done) break;
            }
        }
        return false;
    }


    // ========================= 资产与许可证创建 =========================
    // 公共资产创建接口：不得包含 CID 或其他明确标记的敏感字段。
    async CreateAsset(ctx, assetJSON) {
        let asset;
        try {
            asset = JSON.parse(assetJSON);
        } catch (_) {
            throw new Error('assetJSON 必须是合法 JSON');
        }
        this._validatePublicAssetInput(asset);
        return this._createAsset(ctx, asset, null);
    }

    // PDC 资产创建接口：公共参数与 transient 私有参数在同一交易中原子写入。
    async CreateAssetWithPrivateData(ctx, assetJSON) {
        let asset;
        try {
            asset = JSON.parse(assetJSON);
        } catch (_) {
            throw new Error('assetJSON 必须是合法 JSON');
        }
        this._validatePublicAssetInput(asset);
        if (!asset.assetId) throw new Error('assetId 不能为空');

        const privateData = this._parsePrivateAssetData(ctx, asset.assetId);
        return this._createAsset(ctx, asset, privateData);
    }

    // 创建资产（不可变）；发布者来自 X509 身份。所有权证书单独颁发。
    async _createAsset(ctx, asset, privateData) {
        const publisher = this.getCallerCert(ctx);

        // [Compliance] 验证发布者合规性 (需注册且信用 >= 1)
        const publisherProfile = await this._checkComplianceRemote(ctx, publisher, 'UPLOAD_ASSET', 1, '');
        const publisherEnterpriseId = publisherProfile?.enterpriseId;
        if (!publisherEnterpriseId) throw new Error('发布者未绑定企业，无法创建资产');

        const assetId = asset.assetId;
        if (!assetId) throw new Error('assetId 不能为空');
        const existing = await ctx.stub.getState(assetId);
        if (existing && existing.length > 0) throw new Error(`资产 ${assetId} 已存在`);
        const txTime = txTimestamp(ctx);

        // 构造不可变公共资产记录。CID 仅允许进入 PDC，不进入公共世界状态。
        const record = {
            docType: DOC.ASSET,
            assetId: asset.assetId,
            level: asset.level,
            type: asset.type,
            name: asset.name,
            filehash: asset.filehash,
            filesize: asset.filesize,
            metadata: asset.metadata || {},
            publisherEnterpriseId,
            createdAt: txTime.iso,
            hasPrivateData: Boolean(privateData),
            privateCollection: privateData ? PRIVATE_COLLECTION : null,
            privateDataHash: privateData ? sha256Hex(privateData.privateBytes) : null
        };

        if (privateData) {
            const existingPrivateHash = await ctx.stub.getPrivateDataHash(PRIVATE_COLLECTION, assetId);
            if (existingPrivateHash && existingPrivateHash.length > 0) {
                throw new Error(`资产 ${assetId} 的私有信息已存在`);
            }
            await ctx.stub.putPrivateData(PRIVATE_COLLECTION, assetId, privateData.privateBytes);
        }
        await ctx.stub.putState(assetId, toBuffer(record));
        console.log(`资产 ${assetId} 已创建，PDC=${Boolean(privateData)}`);

        // 资产复合键索引（LevelDB）
        await this.putIndex(ctx, 'asset~assetId', [assetId]);
        await this.putIndex(ctx, 'asset~publisherEnterpriseId', [publisherEnterpriseId, assetId]);

        // [Compliance] 增加发布者活跃度
        await this._incrementTxRemote(ctx, publisher);

        return JSON.stringify({
            assetId,
            enterpriseId: publisherEnterpriseId,
            hasPrivateData: Boolean(privateData),
            privateDataHash: record.privateDataHash,
            details: "asset has been created"
        });
    }

    //  颁发所有权许可证（企业维度，可多持有者）
    async IssueOwnerLicense(ctx, licenseJSON) {
        try { console.log(`[${ctx.stub.getTxID()}] IssueOwnerLicense input=${licenseJSON}`); } catch (_) { }
        const caller = this.getCallerCert(ctx);
        //确认用户有权限被颁发所有权
        const callerProfile = await this._checkComplianceRemote(ctx, caller, 'TRANSFER_OWNER', 0, '');

        const req = JSON.parse(licenseJSON);
        const assetId = req.assetId;
        if (!assetId) throw new Error('assetId 不能为空');

        const enterpriseId = req.enterpriseId && String(req.enterpriseId).length > 0 ? String(req.enterpriseId) : null;
        if (!enterpriseId) throw new Error('enterpriseId 不能为空');

        const txTime = txTimestamp(ctx);

        // 检查资产是否存在
        const assetBytes = await ctx.stub.getState(assetId);
        if (!assetBytes || assetBytes.length === 0) throw new Error(`资产 ${assetId} 不存在`);
        const assetObj = JSON.parse(assetBytes.toString());
        const meta = assetObj.metadata || {};
        let minScore = 0;
        let country = '';
        if (meta.minCreditScore) minScore = parseInt(meta.minCreditScore);
        if (meta.country) country = meta.country;

        // 检查是否已有该企业的 ACTIVE 所有者证
        const alreadyOwner = await this.hasActiveOwnerLicense(ctx, enterpriseId, assetId);
        if (alreadyOwner) throw new Error(`企业 ${enterpriseId} 已持有资产 ${assetId} 的 ACTIVE 所有权证书`);

        const licenseId = req.licenseId && String(req.licenseId).length > 0 ? String(req.licenseId) : `OWN_${assetId}_${txTime.seconds}_${txTime.nanos}`;
        const ownerLic = {
            docType: DOC.OWNER_LICENSE,
            licenseId,
            assetId,
            issuedAt: txTime.iso,
            enterpriseId,
            issuedBy: callerProfile?.enterpriseId || null,
            status: STATUS.ACTIVE,
            revenueSharePct: req.revenueSharePct ? String(req.revenueSharePct) : '0'
        };

        await ctx.stub.putState(licenseId, toBuffer(ownerLic));
        await this.putIndex(ctx, 'licenseOwner~assetId', [assetId, licenseId]);
        await this.putIndex(ctx, 'licenseOwner~enterpriseId', [enterpriseId, assetId, licenseId]);
        try { console.log(`[${ctx.stub.getTxID()}] IssueOwnerLicense -> created licenseId=${licenseId} assetId=${assetId} enterprise=${enterpriseId}`); } catch (_) { }

        // [Compliance] 增加活跃度
        await this._incrementTxRemote(ctx, caller);

        return JSON.stringify({ details: "owner license has been issued", licenseId: licenseId });
    }

    //  创建使用许可证
    async CreateUsageLicense(ctx, licenseJSON) {
        try { console.log(`[${ctx.stub.getTxID()}] CreateUsageLicense input=${licenseJSON}`); } catch (_) { }

        const caller = this.getCallerCert(ctx);

        const req = JSON.parse(licenseJSON);
        const assetId = req.assetId;
        if (!assetId) throw new Error('assetId 不能为空');
        const txTime = txTimestamp(ctx);

        const assetBytes = await ctx.stub.getState(assetId);
        if (!assetBytes || assetBytes.length === 0) throw new Error(`资产 ${assetId} 不存在`);

        let minScore = 0;
        let country = '';

        try {
            const assetObj = JSON.parse(assetBytes.toString());
            const meta = assetObj.metadata || {};
            if (meta.minCreditScore) minScore = parseInt(meta.minCreditScore);
            if (meta.country) country = meta.country;
        } catch (_) { }

        const callerProfile = await this._checkComplianceRemote(ctx, caller, 'ACQUIRE_USAGE', minScore, country);

        let enterpriseId = req.enterpriseId && String(req.enterpriseId).length > 0 ? String(req.enterpriseId) : callerProfile?.enterpriseId;

        if (!enterpriseId) throw new Error('enterpriseId 不能为空');

        if (callerProfile?.enterpriseId && callerProfile.enterpriseId !== enterpriseId) {
            throw new Error('调用者所属企业与目标 enterpriseId 不一致');
        }


        const alreadyHas = await this.hasActiveUsageLicense(ctx, enterpriseId, assetId);
        if (alreadyHas) throw new Error(`企业 ${enterpriseId} 已拥有资产 ${assetId} 的 ACTIVE 使用许可证`);

        const licenseId = req.licenseId && String(req.licenseId).length > 0 ? String(req.licenseId) : `USE_${assetId}_${txTime.seconds}_${txTime.nanos}`;
        const lic = {
            docType: DOC.USAGE_LICENSE,
            licenseId,
            assetId,
            issuedAt: txTime.iso,
            enterpriseId,
            status: STATUS.ACTIVE
        };
        await ctx.stub.putState(licenseId, toBuffer(lic));
        await this.putIndex(ctx, 'licenseUse~assetId', [assetId, licenseId]);
        await this.putIndex(ctx, 'licenseUse~enterpriseId', [enterpriseId, assetId, licenseId]);
        try { console.log(`[${ctx.stub.getTxID()}] CreateUsageLicense -> created licenseId=${licenseId} assetId=${assetId} enterprise=${enterpriseId}`); } catch (_) { }

        await this._incrementTxRemote(ctx, caller);


        return JSON.stringify({ details: "usage license has been created", licenseId: licenseId });
    }

    //  创建数字血缘（谱系）记录，支持一子多父；仅子资产当前所有者可添加
    async CreateLineage(ctx, lineageJSON) {

        try { console.log(`[${ctx.stub.getTxID()}] CreateLineage input=${lineageJSON}`); } catch (_) { }
        const lin = JSON.parse(lineageJSON);
        if (!lin.childAssetId || !lin.parentAssetId || !lin.relationType) {
            throw new Error('childAssetId、parentAssetId、relationType 不能为空');
        }
        const txTime = txTimestamp(ctx);

        // 校验子资产所有权
        const caller = this.getCallerCert(ctx);
        const profile = await this._checkComplianceRemote(ctx, caller, 'MAINTAIN_ASSET', 0, '');
        const enterpriseId = profile?.enterpriseId;
        if (!enterpriseId) throw new Error('身份系统未返回企业信息，无法校验谱系权限');
        const isOwner = await this.hasActiveOwnerLicense(ctx, enterpriseId, lin.childAssetId);
        if (!isOwner) throw new Error('仅拥有子资产所有权的企业可创建谱系记录');

        // 校验父资产存在（父资产允许不属于调用者）
        const parentAssetBytes = await ctx.stub.getState(lin.parentAssetId);
        if (!parentAssetBytes || parentAssetBytes.length === 0) {
            throw new Error(`父资产 ${lin.parentAssetId} 不存在`);
        }
        try {
            const parentObj = parseBuffer(parentAssetBytes);
            if (parentObj.docType && parentObj.docType !== DOC.ASSET) {
                throw new Error(`父资产 ${lin.parentAssetId} 类型不正确`);
            }
        } catch (_) { }

        // 防止自循环与图循环：parent 不可为 child，且 parent 不可通过谱系回溯到 child
        if (lin.childAssetId === lin.parentAssetId) {
            throw new Error('父资产与子资产不能相同（禁止自循环）');
        }
        const willCycle = await this._isReachable(ctx, lin.parentAssetId, lin.childAssetId);
        if (willCycle) {
            throw new Error('该谱系关系会形成循环，已拒绝');
        }

        const relationId = lin.relationId && String(lin.relationId).length > 0 ? String(lin.relationId) : `REL_${lin.childAssetId}_${lin.parentAssetId}_${txTime.seconds}_${txTime.nanos}`;

        const rec = {
            docType: DOC.LINEAGE,
            relationId,
            timestamp: lin.timestamp || txTime.iso,
            childAssetId: lin.childAssetId,
            parentAssetId: lin.parentAssetId,
            relationType: lin.relationType,
            royaltyAgreement: lin.royaltyAgreement || null
        };
        await ctx.stub.putState(relationId, toBuffer(rec));
        await this.putIndex(ctx, 'lineage~childAssetId', [rec.childAssetId, relationId]);
        await this.putIndex(ctx, 'lineage~parentAssetId', [rec.parentAssetId, relationId]);
        await this.putIndex(ctx, 'lineage~relationType', [rec.relationType, relationId]);
        try { console.log(`[${ctx.stub.getTxID()}] CreateLineage -> relationId=${relationId} child=${rec.childAssetId} parent=${rec.parentAssetId}`); } catch (_) { }
        return JSON.stringify({ details: "lineage record has been created", relationId: relationId });
    }

    // ========================= 撤销与转移 =========================

    //  通用撤销许可证：仅 Org3MSP 平台管理员可撤销（可直接指定 licenseId，或通过 assetId+enterpriseId 推断）
    async RevokeLicense(ctx, licenseId, assetId, enterpriseId, licenseType) {
        try { console.log(`[${ctx.stub.getTxID()}] RevokeLicense input licenseId=${licenseId || ''} assetId=${assetId || ''} enterpriseId=${enterpriseId || ''} type=${licenseType || ''}`); } catch (_) { }
        const mspId = ctx.clientIdentity.getMSPID();
        if (mspId !== 'Org3MSP') throw new Error('仅 Org3MSP 可撤销许可证');
        const docType = licenseType === DOC.OWNER_LICENSE || licenseType === DOC.USAGE_LICENSE ? licenseType : undefined;
        const { licId, licObj } = await this.resolveLicense(ctx, { licenseId, assetId, enterpriseId, docType });

        if (licObj.status === STATUS.REVOKED) throw new Error('许可证已是 REVOKED 状态');

        licObj.status = STATUS.REVOKED;
        await ctx.stub.putState(licId, toBuffer(licObj));
        try { console.log(`[${ctx.stub.getTxID()}] RevokeLicense -> revoked ${licId} type=${licObj.docType}`); } catch (_) { }
        // 根据类型清理相关索引（保留 asset 维度索引便于历史）
        if (licObj.docType === DOC.OWNER_LICENSE) {
            await this.delIndex(ctx, 'licenseOwner~enterpriseId', [licObj.enterpriseId, licObj.assetId, licId]);
        } else if (licObj.docType === DOC.USAGE_LICENSE) {
            await this.delIndex(ctx, 'licenseUse~enterpriseId', [licObj.enterpriseId, licObj.assetId, licId]);
        }

        return JSON.stringify({ details: "license has been revoked", licenseId: licId });
    }

    //  撤销所有者许可证（向后兼容）：调用通用撤销
    async RevokeOwnerLicense(ctx, assetId, enterpriseId) {
        try { console.log(`[${ctx.stub.getTxID()}] RevokeOwnerLicense assetId=${assetId} enterpriseId=${enterpriseId || ''}`); } catch (_) { }
        return this.RevokeLicense(ctx, null, assetId, enterpriseId, DOC.OWNER_LICENSE);
    }

    //  撤销使用许可证（向后兼容）：调用通用撤销
    async RevokeUsageLicense(ctx, assetId, enterpriseId) {
        try { console.log(`[${ctx.stub.getTxID()}] RevokeUsageLicense assetId=${assetId} enterpriseId=${enterpriseId || ''}`); } catch (_) { }
        return this.RevokeLicense(ctx, null, assetId, enterpriseId, DOC.USAGE_LICENSE);
    }

    //  转移资产：需提供所有权许可证 ID，并将所有权转移至目标企业
    async TransferAsset(ctx, licenseId, newEnterpriseId) {
        try { console.log(`[${ctx.stub.getTxID()}] TransferAsset licenseId=${licenseId || ''} newEnterpriseId=${newEnterpriseId || ''}`); } catch (_) { }
        if (!licenseId || String(licenseId).length === 0) throw new Error('licenseId 不能为空');
        if (!newEnterpriseId || String(newEnterpriseId).length === 0) throw new Error('newEnterpriseId 不能为空');

        const caller = this.getCallerCert(ctx);
        const callerProfile = await this._checkComplianceRemote(ctx, caller, 'TRANSFER_OWNER', 0, '');
        const callerEnterpriseId = callerProfile?.enterpriseId;
        if (!callerEnterpriseId) throw new Error('调用者未绑定企业，无法转移资产');

        const raw = await ctx.stub.getState(licenseId);
        if (!raw || raw.length === 0) throw new Error(`许可证 ${licenseId} 不存在`);
        const lic = parseBuffer(raw);
        if (lic.docType !== DOC.OWNER_LICENSE) throw new Error('仅支持转移所有权许可证');
        if (lic.status !== STATUS.ACTIVE) throw new Error('许可证必须处于 ACTIVE 状态才能转移');
        if (lic.enterpriseId !== callerEnterpriseId) throw new Error('仅当前持有该许可证的企业可发起转移');
        if (callerEnterpriseId === newEnterpriseId) throw new Error('目标企业与当前企业相同，无需转移');

        const assetBytes = await ctx.stub.getState(lic.assetId);
        let minScore = 0;
        let country = '';
        if (assetBytes && assetBytes.length > 0) {
            try {
                const assetObj = JSON.parse(assetBytes.toString());
                const meta = assetObj.metadata || {};
                if (meta.minCreditScore) minScore = parseInt(meta.minCreditScore);
                if (meta.country) country = meta.country;
            } catch (_) { }
        }

        const txTime = txTimestamp(ctx);
        await this.delIndex(ctx, 'licenseOwner~enterpriseId', [lic.enterpriseId, lic.assetId, licenseId]);
        lic.enterpriseId = String(newEnterpriseId);
        lic.transferredAt = txTime.iso;
        await ctx.stub.putState(licenseId, toBuffer(lic));
        await this.putIndex(ctx, 'licenseOwner~enterpriseId', [lic.enterpriseId, lic.assetId, licenseId]);
        try { console.log(`[${ctx.stub.getTxID()}] TransferAsset -> ${lic.assetId} enterprise ${callerEnterpriseId} -> ${newEnterpriseId} via ${licenseId}`); } catch (_) { }

        await this._incrementTxRemote(ctx, caller);

        return JSON.stringify({ details: "asset has been transferred", licenseId: licenseId });
    }

    //  获取当前已撤销的许可证列表（分页，可选 bookmark），支持 OWNER/USAGE 类型
    async GetRevokedLicenses(ctx, pageSizeStr, bookmark) {
        try { console.log(`[${ctx.stub.getTxID()}] GetRevokedLicenses pageSize=${pageSizeStr || '20'} bookmark=${bookmark || ''}`); } catch (_) { }
        const pageSize = parseInt(pageSizeStr || '20', 10);
        if (isNaN(pageSize) || pageSize <= 0) throw new Error('pageSize 必须为正整数');

        const { iterator, metadata } = await ctx.stub.getStateByRangeWithPagination('', '', pageSize, bookmark || '');
        const out = [];
        while (true) {
            const res = await iterator.next();
            if (res.value) {
                try {
                    const obj = JSON.parse(res.value.value.toString('utf8'));
                    if ((obj.docType === DOC.OWNER_LICENSE || obj.docType === DOC.USAGE_LICENSE) && obj.status === STATUS.REVOKED) {
                        out.push(obj);
                    }
                } catch (_) { /* ignore */ }
            }
            if (res.done) break;
        }
        try { console.log(`[${ctx.stub.getTxID()}] GetRevokedLicenses -> count=${out.length}`); } catch (_) { }
        return JSON.stringify({ records: out, metadata });
    }

    // ========================= 查询接口（强制权限） =========================

    //  读取资产详情（需有 ACTIVE 所有者或使用许可证之一）
    async GetAsset(ctx, assetId) {
        try { console.log(`[${ctx.stub.getTxID()}] GetAsset assetId=${assetId}`); } catch (_) { }
        // 校验读权限
        await this.assertReadPermission(ctx, assetId);

        const raw = await ctx.stub.getState(assetId);
        if (!raw || raw.length === 0) throw new Error(`资产 ${assetId} 不存在`);
        try { console.log(`[${ctx.stub.getTxID()}] GetAsset -> ok assetId=${assetId}`); } catch (_) { }
        return raw.toString();
    }

    // 读取 PDC 中的敏感资产信息。PDC 负责组织级隔离，身份链码和 ROC/RUC 负责业务级授权。
    async GetAssetPrivateData(ctx, assetId) {
        this._assertPrivateCollectionMember(ctx);

        const assetBytes = await ctx.stub.getState(assetId);
        if (!assetBytes || assetBytes.length === 0) throw new Error(`资产 ${assetId} 不存在`);
        const asset = parseBuffer(assetBytes);
        if (asset.docType !== DOC.ASSET) throw new Error(`${assetId} 不是有效的遥感资产`);
        if (!asset.hasPrivateData) throw new Error(`资产 ${assetId} 未登记 PDC 私有信息`);

        // 必须同时满足 READ_ASSET 以及企业对该资产持有 ACTIVE ROC/RUC。
        await this.assertReadPermission(ctx, assetId);

        const privateBytes = await ctx.stub.getPrivateData(PRIVATE_COLLECTION, assetId);
        if (!privateBytes || privateBytes.length === 0) {
            throw new Error(`当前 Peer 未获得资产 ${assetId} 的私有信息，或私有信息已过期`);
        }
        return privateBytes.toString();
    }

    // 返回公共区块承诺的 PDC 哈希，用于非成员组织或审计方验证私有数据一致性。
    async GetAssetPrivateDataHash(ctx, assetId) {
        const assetBytes = await ctx.stub.getState(assetId);
        if (!assetBytes || assetBytes.length === 0) throw new Error(`资产 ${assetId} 不存在`);
        const asset = parseBuffer(assetBytes);
        if (!asset.hasPrivateData) throw new Error(`资产 ${assetId} 未登记 PDC 私有信息`);

        const hashBytes = await ctx.stub.getPrivateDataHash(PRIVATE_COLLECTION, assetId);
        if (!hashBytes || hashBytes.length === 0) {
            throw new Error(`资产 ${assetId} 的 PDC 哈希不存在`);
        }
        const ledgerHash = hashBytes.toString('hex');
        return JSON.stringify({
            assetId,
            collection: PRIVATE_COLLECTION,
            ledgerHash,
            recordedHash: asset.privateDataHash || null,
            matched: !asset.privateDataHash || asset.privateDataHash === ledgerHash
        });
    }

    //  分页获取所有资产（仅返回调用者可访问资产）
    async GetAllAssets(ctx, pageSizeStr, bookmark) {
        try { console.log(`[${ctx.stub.getTxID()}] GetAllAssets pageSize=${pageSizeStr || '10'} bookmark=${bookmark || ''}`); } catch (_) { }
        const pageSize = parseInt(pageSizeStr || '10', 10);
        if (isNaN(pageSize) || pageSize <= 0) throw new Error('pageSize 必须为正整数');
        const caller = this.getCallerCert(ctx);
        const profile = await this._checkComplianceRemote(ctx, caller, 'READ_ASSET', 0, '');
        const enterpriseId = profile?.enterpriseId;
        if (!enterpriseId) throw new Error('身份系统未返回企业信息，无法分页查询资产');

        // 使用 asset~assetId 索引扫描并手动分页（bookmark 为上一页最后一个 assetId）
        const iter = await ctx.stub.getStateByPartialCompositeKey('asset~assetId', []);
        const records = [];
        let started = bookmark ? false : true;
        let nextBookmark = '';
        while (true) {
            const res = await iter.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const aid = split.attributes[0];
                if (!started) {
                    if (aid === bookmark) { started = true; continue; }
                }
                if (started && records.length < pageSize) {
                    const raw = await ctx.stub.getState(aid);
                    if (raw && raw.length > 0) {
                        try {
                            const obj = parseBuffer(raw);
                            if (obj.docType === DOC.ASSET) {
                                const hasOwner = await this.hasActiveOwnerLicense(ctx, enterpriseId, aid);
                                const hasUsage = hasOwner ? true : await this.hasActiveUsageLicense(ctx, enterpriseId, aid);
                                if (hasOwner || hasUsage) {
                                    records.push(obj);
                                    nextBookmark = aid;
                                }
                            }
                        } catch (_) { }
                    }
                }
                if (started && records.length >= pageSize) break;
            }
            if (res.done) break;
        }
        try { console.log(`[${ctx.stub.getTxID()}] GetAllAssets -> count=${records.length} nextBookmark=${nextBookmark}`); } catch (_) { }
        return JSON.stringify({ records, nextBookmark });
    }

    //  测试接口：分页获取所有资产（忽略权限）
    async TestGetAllAssets(ctx, pageSizeStr, bookmark) {
        try { console.log(`[${ctx.stub.getTxID()}] TestGetAllAssets pageSize=${pageSizeStr || '20'} bookmark=${bookmark || ''}`); } catch (_) { }
        const pageSize = parseInt(pageSizeStr || '20', 10);
        if (isNaN(pageSize) || pageSize <= 0) throw new Error('pageSize 必须为正整数');

        const { iterator, metadata } = await ctx.stub.getStateByRangeWithPagination('', '', pageSize, bookmark || '');
        const records = [];
        while (true) {
            const res = await iterator.next();
            if (res.value) {
                try {
                    const obj = JSON.parse(res.value.value.toString('utf8'));
                    if (obj.docType === DOC.ASSET) {
                        records.push(obj);
                    }
                } catch (_) { /* ignore */ }
            }
            if (res.done) break;
        }
        try { console.log(`[${ctx.stub.getTxID()}] TestGetAllAssets -> count=${records.length}`); } catch (_) { }
        return JSON.stringify({ records, metadata });
    }

    //  测试接口：分页获取所有许可证（忽略权限）
    async TestGetAllLicenses(ctx, pageSizeStr, bookmark) {
        try { console.log(`[${ctx.stub.getTxID()}] TestGetAllLicenses pageSize=${pageSizeStr || '50'} bookmark=${bookmark || ''}`); } catch (_) { }
        const pageSize = parseInt(pageSizeStr || '50', 10);
        if (isNaN(pageSize) || pageSize <= 0) throw new Error('pageSize 必须为正整数');

        const { iterator, metadata } = await ctx.stub.getStateByRangeWithPagination('', '', pageSize, bookmark || '');
        const records = [];
        while (true) {
            const res = await iterator.next();
            if (res.value) {
                try {
                    const obj = JSON.parse(res.value.value.toString('utf8'));
                    if (obj.docType === DOC.OWNER_LICENSE || obj.docType === DOC.USAGE_LICENSE) {
                        records.push(obj);
                    }
                } catch (_) { /* ignore */ }
            }
            if (res.done) break;
        }
        try { console.log(`[${ctx.stub.getTxID()}] TestGetAllLicenses -> count=${records.length}`); } catch (_) { }
        return JSON.stringify({ records, metadata });
    }

    //  根据资产ID查询谱系（该资产作为父或子参与的所有谱系）
    async GetLineageByAsset(ctx, assetId) {
        try { console.log(`[${ctx.stub.getTxID()}] GetLineageByAsset assetId=${assetId}`); } catch (_) { }
        await this.assertReadPermission(ctx, assetId);

        const out = [];
        const childIter = await ctx.stub.getStateByPartialCompositeKey('lineage~childAssetId', [assetId]);
        while (true) {
            const res = await childIter.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const relationId = split.attributes[1];
                const raw = await ctx.stub.getState(relationId);
                if (raw && raw.length > 0) out.push(parseBuffer(raw));
            }
            if (res.done) break;
        }
        const parentIter = await ctx.stub.getStateByPartialCompositeKey('lineage~parentAssetId', [assetId]);
        while (true) {
            const res = await parentIter.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const relationId = split.attributes[1];
                const raw = await ctx.stub.getState(relationId);
                if (raw && raw.length > 0) out.push(parseBuffer(raw));
            }
            if (res.done) break;
        }
        try { console.log(`[${ctx.stub.getTxID()}] GetLineageByAsset -> count=${out.length}`); } catch (_) { }
        return JSON.stringify(out);
    }

    //  测试接口：无视权限获取指定资产谱系
    async TestGetLineageByAsset(ctx, assetId) {
        try { console.log(`[${ctx.stub.getTxID()}] TestGetLineageByAsset assetId=${assetId}`); } catch (_) { }

        const out = [];
        const childIter = await ctx.stub.getStateByPartialCompositeKey('lineage~childAssetId', [assetId]);
        while (true) {
            const res = await childIter.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const relationId = split.attributes[1];
                const raw = await ctx.stub.getState(relationId);
                if (raw && raw.length > 0) out.push(parseBuffer(raw));
            }
            if (res.done) break;
        }
        const parentIter = await ctx.stub.getStateByPartialCompositeKey('lineage~parentAssetId', [assetId]);
        while (true) {
            const res = await parentIter.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const relationId = split.attributes[1];
                const raw = await ctx.stub.getState(relationId);
                if (raw && raw.length > 0) out.push(parseBuffer(raw));
            }
            if (res.done) break;
        }
        try { console.log(`[${ctx.stub.getTxID()}] TestGetLineageByAsset -> count=${out.length}`); } catch (_) { }
        return JSON.stringify(out);
    }

    //  统一历史时间线（资产+所有者许可证+使用许可证）
    async GetAssetHistory(ctx, assetId) {
        try { console.log(`[${ctx.stub.getTxID()}] GetAssetHistory assetId=${assetId}`); } catch (_) { }

        await this.assertReadPermission(ctx, assetId);
        const timeline = [];

        // 资产历史
        const aIter = await ctx.stub.getHistoryForKey(assetId);
        while (true) {
            const res = await aIter.next();
            if (res.value) {
                const evt = {
                    type: 'ASSET',
                    txId: res.value.txId,
                    timestamp: tsToISO(res.value.timestamp),
                    isDelete: res.value.isDelete,
                    value: null
                };
                if (!res.value.isDelete) {
                    try { evt.value = JSON.parse(res.value.value.toString('utf8')); } catch (_) { evt.value = res.value.value.toString('utf8'); }
                }
                timeline.push(evt);
            }
            if (res.done) break;
        }

        // 所有者许可证历史
        const ownerIdx = await ctx.stub.getStateByPartialCompositeKey('licenseOwner~assetId', [assetId]);
        while (true) {
            const res = await ownerIdx.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const licenseId = split.attributes[1];
                const hIter = await ctx.stub.getHistoryForKey(licenseId);
                while (true) {
                    const r2 = await hIter.next();
                    if (r2.value) {
                        const evt = {
                            type: 'OWNER_LICENSE',
                            txId: r2.value.txId,
                            timestamp: tsToISO(r2.value.timestamp),
                            isDelete: r2.value.isDelete,
                            value: null
                        };
                        if (!r2.value.isDelete) {
                            try { evt.value = JSON.parse(r2.value.value.toString('utf8')); } catch (_) { evt.value = r2.value.value.toString('utf8'); }
                        }
                        timeline.push(evt);
                    }
                    if (r2.done) break;
                }
            }
            if (res.done) break;
        }

        // 使用许可证历史
        const useIdx = await ctx.stub.getStateByPartialCompositeKey('licenseUse~assetId', [assetId]);
        while (true) {
            const res = await useIdx.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const licenseId = split.attributes[1];
                const hIter = await ctx.stub.getHistoryForKey(licenseId);
                while (true) {
                    const r2 = await hIter.next();
                    if (r2.value) {
                        const evt = {
                            type: 'USAGE_LICENSE',
                            txId: r2.value.txId,
                            timestamp: tsToISO(r2.value.timestamp),
                            isDelete: r2.value.isDelete,
                            value: null
                        };
                        if (!r2.value.isDelete) {
                            try { evt.value = JSON.parse(r2.value.value.toString('utf8')); } catch (_) { evt.value = r2.value.value.toString('utf8'); }
                        }
                        timeline.push(evt);
                    }
                    if (r2.done) break;
                }
            }
            if (res.done) break;
        }

        // 时间排序
        timeline.sort((a, b) => {
            const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
            const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
            return ta - tb;
        });
        try { console.log(`[${ctx.stub.getTxID()}] GetAssetHistory -> events=${timeline.length}`); } catch (_) { }
        return JSON.stringify(timeline);
    }

    //  获取调用者身份证书字符串（调试辅助）
    async GetCallerId(ctx) {
        const id = this.getCallerCert(ctx);
        try { console.log(`[${ctx.stub.getTxID()}] GetCallerId -> ${id}`); } catch (_) { }
        return id;
    }

    //  获取用户的所有许可证（所有者许可证和使用许可证）
    async GetLicensesByUser(ctx) {
        try {
            const caller = this.getCallerCert(ctx);
            const profile = await this._checkComplianceRemote(ctx, caller, 'READ_ASSET', 0, '');
            const enterpriseId = profile?.enterpriseId;
            if (!enterpriseId) {
                throw new Error('未找到企业ID');
            }

            const licenses = [];

            // 获取所有者许可证
            const ownerIter = await ctx.stub.getStateByPartialCompositeKey('licenseOwner~enterpriseId', [enterpriseId]);
            while (true) {
                const res = await ownerIter.next();
                if (res.value) {
                    const key = res.value.key;
                    const split = ctx.stub.splitCompositeKey(key);
                    const licenseId = split.attributes[2];
                    const licBytes = await ctx.stub.getState(licenseId);
                    if (licBytes && licBytes.length > 0) {
                        const lic = parseBuffer(licBytes);
                        licenses.push(lic);
                    }
                }
                if (res.done) break;
            }

            // 获取使用许可证
            const useIter = await ctx.stub.getStateByPartialCompositeKey('licenseUse~enterpriseId', [enterpriseId]);
            while (true) {
                const res = await useIter.next();
                if (res.value) {
                    const key = res.value.key;
                    const split = ctx.stub.splitCompositeKey(key);
                    const licenseId = split.attributes[2];
                    const licBytes = await ctx.stub.getState(licenseId);
                    if (licBytes && licBytes.length > 0) {
                        const lic = parseBuffer(licBytes);
                        licenses.push(lic);
                    }
                }
                if (res.done) break;
            }

            try { console.log(`[${ctx.stub.getTxID()}] GetLicensesByUser -> ${licenses.length} licenses`); } catch (_) { }
            return JSON.stringify(licenses);
        } catch (error) {
            console.error('获取许可证失败:', error);
            throw error;
        }
    }

    //  测试接口: 根据企业ID获取该企业的所有许可证（无权限校验）
    async TestGetLicensesByEnterprise(ctx, enterpriseId) {
        try { console.log(`[${ctx.stub.getTxID()}] TestGetLicensesByEnterprise enterpriseId=${enterpriseId}`); } catch (_) { }
        if (!enterpriseId) throw new Error('enterpriseId 不能为空');

        const licenses = [];

        // 获取所有者许可证
        const ownerIter = await ctx.stub.getStateByPartialCompositeKey('licenseOwner~enterpriseId', [enterpriseId]);
        while (true) {
            const res = await ownerIter.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const licenseId = split.attributes[2];
                const licBytes = await ctx.stub.getState(licenseId);
                if (licBytes && licBytes.length > 0) {
                    licenses.push(parseBuffer(licBytes));
                }
            }
            if (res.done) break;
        }

        // 获取使用许可证
        const useIter = await ctx.stub.getStateByPartialCompositeKey('licenseUse~enterpriseId', [enterpriseId]);
        while (true) {
            const res = await useIter.next();
            if (res.value) {
                const split = ctx.stub.splitCompositeKey(res.value.key);
                const licenseId = split.attributes[2];
                const licBytes = await ctx.stub.getState(licenseId);
                if (licBytes && licBytes.length > 0) {
                    licenses.push(parseBuffer(licBytes));
                }
            }
            if (res.done) break;
        }

        try { console.log(`[${ctx.stub.getTxID()}] TestGetLicensesByEnterprise -> ${licenses.length} licenses`); } catch (_) { }
        return JSON.stringify(licenses);
    }

    // ========================= 跨链码调用辅助 =========================

    // 调用 rsidentity 链码检查合规性
    async _checkComplianceRemote(ctx, userId, permission, minScore, countryCode) {
        try {
            console.log(`[${ctx.stub.getTxID()}] Calling rsidentity:CheckCompliance for ${userId}, perm=${permission}, min=${minScore}, country=${countryCode}`);

            let countriesJSON = '[]';
            if (countryCode && countryCode.length > 0) {
                countriesJSON = JSON.stringify([countryCode]);
            }

            const args = ['CheckCompliance', userId, permission, String(minScore), countriesJSON];
            const response = await ctx.stub.invokeChaincode('rsidentity', args, ctx.stub.getChannelID());

            if (response.status !== 200) {
                const msg = response.message || (response.payload ? response.payload.toString('utf8') : 'Unknown Error');
                throw new Error(msg);
            }

            const payloadStr = response.payload ? response.payload.toString('utf8') : '{}';
            try {
                return JSON.parse(payloadStr);
            } catch (err) {
                throw new Error(`合规性响应解析失败: ${err.message}`);
            }
        } catch (err) {
            console.error(`Compliance check error: ${err.message}`);
            throw new Error(`合规性检查失败 (Identity Oracle): ${err.message}`);
        }
    }

    // 调用 rsidentity 链码增加交易计数
    async _incrementTxRemote(ctx, userId) {
        try {
            console.log(`[${ctx.stub.getTxID()}] Calling rsidentity:IncrementTxCount for ${userId}`);
            const args = ['IncrementTxCount', userId];
            const response = await ctx.stub.invokeChaincode('rsidentity', args, ctx.stub.getChannelID());

            if (response.status !== 200) {
                const msg = response.message || (response.payload ? response.payload.toString('utf8') : 'Unknown Error');
                console.warn(`Failed to increment tx count: ${msg}`);
            }
        } catch (err) {
            console.error(`IncrementTxCount error: ${err.message}`);
        }
    }

}

module.exports = RSDataContract;
