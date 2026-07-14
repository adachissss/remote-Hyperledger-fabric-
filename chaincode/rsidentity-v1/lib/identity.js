"use strict";

const { Contract } = require("fabric-contract-api");

const MSP_ADMIN = "Org1MSP";     // 企业管理员 (Org1)
const MSP_USER = "Org2MSP";      // 普通用户 (Org2)
const MSP_REGULATOR = "Org3MSP"; // 监管方 (Org3)

const DOC_TYPE_ENTERPRISE = "Enterprise";
const DOC_TYPE_USER = "UserAsset";

// 权限常量定义
const PERM_ACQUIRE = "ACQUIRE_USAGE";   // 权限1：获取使用权
const PERM_UPLOAD = "UPLOAD_ASSET";     // 权限2：上传/创建资产
const PERM_MAINTAIN = "MAINTAIN_ASSET"; // 权限3：维护资产 (更新/删除/状态变更)
const PERM_TRANSFER = "TRANSFER_OWNER"; // 权限4：转移所有权
const PERM_READ = "READ_ASSET";         // 权限5：读取资产
const PERM_CREATE_REPORT = "CREATE_REPORT"; // 权限6：创建报告
const PERM_VIEW_REPORT = "VIEW_REPORT";     // 权限7：查看报告

// 有效权限列表
const VALID_PERMISSIONS = [PERM_ACQUIRE, PERM_UPLOAD, PERM_MAINTAIN, PERM_TRANSFER, PERM_READ, PERM_CREATE_REPORT, PERM_VIEW_REPORT];

class RSIdentity extends Contract {

    async Init(ctx) {
        console.info("RSIdentity ChaincodeInitialized");
        return;
    }

    _getTxDate(ctx) {
        const txTimestamp = ctx.stub.getTxTimestamp();
        return new Date(txTimestamp.seconds.low * 1000).toISOString();
    }

    /**
     * 辅助函数：获取调用者的角色
     */
    _getCallerRole(ctx) {
        const mspId = ctx.clientIdentity.getMSPID();
        if (mspId === MSP_REGULATOR) return "REGULATOR";
        if (mspId === MSP_ADMIN) return "ADMIN";
        if (mspId === MSP_USER) return "USER";
        return "UNKNOWN";
    }

    /**
     * 辅助函数：校验权限数组格式
     */
    _validatePermissions(perms) {
        if (!Array.isArray(perms)) throw new Error("权限必须是数组格式");
        for (const p of perms) {
            if (!VALID_PERMISSIONS.includes(p)) {
                throw new Error(`无效的权限类型: ${p}`);
            }
        }
    }

    /**
     * 辅助函数：计算企业信誉分
     * 公式 = 国家系数 + 10*规模 + 入链天数/15 + 交易量*2
     */
    _calculateCreditScore(enterprise, ctx) {
        // 1. 国家系数
        let countryCoeff = 0;
        const c = enterprise.country.toUpperCase();
        if (c === "SINGAPORE") countryCoeff = 30;
        else if (c === "CHINA") countryCoeff = 30;
        else if (c === "MALAYSIA") countryCoeff = 20;
        else if (c === "THAILAND") countryCoeff = 15;
        else countryCoeff = 40;

        // 2. 规模系数
        const scaleScore = (enterprise.scale || 1) * 10;

        // 3. 入链天数
        const now = new Date(this._getTxDate(ctx)).getTime();
        const createTime = new Date(enterprise.createTime).getTime();
        const diffDays = Math.floor((now - createTime) / (1000 * 60 * 60 * 24));
        const timeScore = Math.floor(diffDays / 15);

        // 4. 交易量
        const txScore = (enterprise.txCount || 0) * 2;

        return countryCoeff + scaleScore + timeScore + txScore;
    }


    // ============================================================
    // 1. 企业资产管理 (监管方 - Org3)
    // ============================================================

    /**
     * 注册或更新企业资产
     * 权限：仅监管方 (Org3) 可执行
     * @param {String} entId - 企业唯一ID
     * @param {String} country - 国家/地区 (如 "China")
     * @param {String} maxPermissionsJSON - 改企业拥有的最大权限集合 ["UPLOAD_ASSET", ...]
     * @param {Number} scale - 企业规模 (1, 2, 3)
     * @param {String} adminID - 该企业的指定管理员ID
     */
    async RegisterEnterprise(ctx, entId, country, maxPermissionsJSON, scale, adminID) {
        if (this._getCallerRole(ctx) !== "REGULATOR") {
            throw new Error("权限拒绝：只有监管方 (Org3) 可以注册企业");
        }

        const maxPermissions = JSON.parse(maxPermissionsJSON);
        this._validatePermissions(maxPermissions);

        // 更新时保留原有的 txCount 和 createTime
        let txCount = 0;
        let createTime = this._getTxDate(ctx);
        const existsBytes = await ctx.stub.getState(entId);
        if (existsBytes && existsBytes.length > 0) {
            const oldEnt = JSON.parse(existsBytes.toString());
            txCount = oldEnt.txCount || 0;
            createTime = oldEnt.createTime || createTime;
        }

        const enterprise = {
            docType: DOC_TYPE_ENTERPRISE, // 文档类型：企业
            id: entId,                    // 企业唯一ID
            country: country,             // 所属国家 (用于合规检查)
            maxPermissions: maxPermissions, // 企业拥有的最大权限集合
            scale: parseInt(scale) || 1,  // 企业规模
            adminId: adminID,             // 绑定该企业的管理员ID
            txCount: txCount,             // 交易数量
            updatedBy: ctx.clientIdentity.getID(), // 最后更新人 (监管员ID)
            updateTime: this._getTxDate(ctx),      // 更新时间
            createTime: createTime        // 入链时间
        };

        await ctx.stub.putState(entId, Buffer.from(JSON.stringify(enterprise)));
        return JSON.stringify(enterprise);
    }

    async GetEnterprise(ctx, entId) {
        const bytes = await ctx.stub.getState(entId);
        if (!bytes || bytes.length === 0) throw new Error(`未找到企业: ${entId}`);
        return bytes.toString();
    }

    // ============================================================
    // 2. 用户资产管理 (企业管理员 - Org1)
    // ============================================================

    /**
     * 注册用户资产
     * 权限：仅企业管理员 (Org1) 可执行，且必须是对应企业的绑定管理员
     */
    async RegisterUser(ctx, targetUserId, entId, permissionsJSON) {
        // 角色检查：必须是 Org1
        if (this._getCallerRole(ctx) !== "ADMIN") {
            throw new Error("权限拒绝：只有企业管理员 (Org1) 可以管理用户");
        }

        // 1. 验证企业是否存在
        const entBytes = await ctx.stub.getState(entId);
        if (!entBytes || entBytes.length === 0) throw new Error(`企业 ${entId} 不存在`);
        const enterprise = JSON.parse(entBytes.toString());

        // 1.5 验证调用者是否为该企业的绑定管理员 (隔离性检查)
        const callerId = ctx.clientIdentity.getID();
        if (enterprise.adminId && enterprise.adminId !== callerId) {
            throw new Error(`权限拒绝：您不是企业 ${entId} 的指定管理员，无法操作该企业用户。`);
        }

        // 2. 验证权限是否有效且在企业权限范围内
        const userPermissions = JSON.parse(permissionsJSON);
        this._validatePermissions(userPermissions);

        // 检查
        const entPermsSet = new Set(enterprise.maxPermissions);
        for (const p of userPermissions) {
            if (!entPermsSet.has(p)) {
                throw new Error(`无法授予用户权限 ${p}，因为企业 ${entId} 未拥有该权限`);
            }
        }

        // 3. 创建用户资产
        const userKey = "USER_" + targetUserId;

        const userAsset = {
            docType: DOC_TYPE_USER,
            id: targetUserId,              // 用户ID
            enterpriseId: entId,           // 归属企业ID
            permissions: userPermissions,  // 拥有的权限列表
            updatedBy: ctx.clientIdentity.getID(), // 创建/修改人
            updateTime: this._getTxDate(ctx)       // 更新时间
        };

        await ctx.stub.putState(userKey, Buffer.from(JSON.stringify(userAsset)));
        return JSON.stringify(userAsset);
    }

    async UpdateUserPermissions(ctx, targetUserId, entId, permissionsJSON) {
        return this.RegisterUser(ctx, targetUserId, entId, permissionsJSON);
    }

    // ============================================================
    // 3. 合规预言机服务
    // ============================================================

    /**
     * 验证身份与合规性
     * 供交易链码 invokeChaincode 调用
     * @param {String} userId - 发起交易的用户ID (x509::...)
     * @param {String} requiredPermission - 本次操作需要的权限
     * @param {String} minScoreStr - 最低信誉分 (String)
     * @param {String} allowedCountriesJSON - 允许国家列表 (JSON String)
     */
    async CheckCompliance(ctx, userId, requiredPermission, minScoreStr, allowedCountriesJSON) {
        console.info(`[RSIdentity Oracle] Checking compliance for User: ${userId}`);

        // 1. 获取用户
        const userKey = "USER_" + userId;
        const userBytes = await ctx.stub.getState(userKey);
        if (!userBytes || userBytes.length === 0) {
            throw new Error(`[合规阻断] 用户 ${userId} 未在身份系统注册`);
        }
        const userAsset = JSON.parse(userBytes.toString());

        // 2. 检查个人权限
        if (requiredPermission && requiredPermission !== "") {
            if (!userAsset.permissions.includes(requiredPermission)) {
                throw new Error(`[合规阻断] 用户缺少必要权限: ${requiredPermission}`);
            }
        }

        // 3. 获取所属企业
        const entBytes = await ctx.stub.getState(userAsset.enterpriseId);
        if (!entBytes || entBytes.length === 0) {
            throw new Error(`[合规阻断] 用户所属企业 ${userAsset.enterpriseId} 状态异常`);
        }
        const enterprise = JSON.parse(entBytes.toString());

        // 4. 检查企业权限 (双重验证)
        if (requiredPermission && requiredPermission !== "") {
            if (!enterprise.maxPermissions.includes(requiredPermission)) {
                throw new Error(`[合规阻断] 企业已被撤销权限: ${requiredPermission}`);
            }
        }

        // 5. 检查信誉分
        const minScore = parseInt(minScoreStr) || 0;
        const currentScore = this._calculateCreditScore(enterprise, ctx);
        if (minScore > 0 && currentScore < minScore) {
            throw new Error(`[合规阻断] 企业信誉分不足: 当前 ${currentScore}, 要求 ${minScore}`);
        }

        // 6. 检查国家准入
        const allowedCountries = JSON.parse(allowedCountriesJSON || '[]');
        if (allowedCountries.length > 0) {
            if (!allowedCountries.includes(enterprise.country)) {
                throw new Error(`[合规阻断] 跨境限制: 企业所在国 ${enterprise.country} 不在允许交易范围`);
            }
        }

        // 验证通过，返回身份概要
        const result = {
            status: "APPROVED",
            userId: userAsset.id,
            userCert: userAsset.id, // 兼容字段
            enterpriseId: enterprise.id,
            country: enterprise.country,
            creditScore: currentScore
        };
        return JSON.stringify(result);
    }

    /**
     * 增加交易计数 (IncrementTxCount)
     * 交易链码交割成功后回调，用于积累信誉
     * 通过个人的证书ID定位企业,添加交易计数
     */
    async IncrementTxCount(ctx, userId) {
        console.info(`[RSIdentity Oracle] Incrementing Tx Count for User: ${userId}`);

        const userKey = "USER_" + userId;
        const userBytes = await ctx.stub.getState(userKey);
        if (!userBytes || userBytes.length === 0) return; // 忽略

        const userAsset = JSON.parse(userBytes.toString());
        const entBytes = await ctx.stub.getState(userAsset.enterpriseId);
        if (!entBytes) return;

        const enterprise = JSON.parse(entBytes.toString());
        // 增加计数
        enterprise.txCount = (enterprise.txCount || 0) + 1;

        await ctx.stub.putState(enterprise.id, Buffer.from(JSON.stringify(enterprise)));

        return JSON.stringify({
            enterpriseId: enterprise.id,
            newTxCount: enterprise.txCount
        });
    }

    // ============================================================
    // 4. 历史溯源 (History & Provenance)
    // ============================================================

    /**
     * 获取企业变更历史 (溯源)
     */
    async GetEnterpriseHistory(ctx, entId) {
        return this._getHistory(ctx, entId);
    }

    /**
     * 获取用户身份变更历史 (溯源)
     */
    async GetUserHistory(ctx, userId) {
        const userKey = "USER_" + userId;
        return this._getHistory(ctx, userKey);
    }

    /**
     * 内部通用历史查询
     */
    async _getHistory(ctx, key) {
        const iterator = await ctx.stub.getHistoryForKey(key);
        const results = [];

        let res = await iterator.next();
        while (!res.done) {
            if (res.value) {
                const obj = {
                    txId: res.value.txId,
                    isDelete: res.value.isDelete
                };

                // 处理时间戳
                if (res.value.timestamp && res.value.timestamp.seconds) {
                    const seconds = res.value.timestamp.seconds.low || res.value.timestamp.seconds;
                    obj.timestamp = new Date(seconds * 1000).toISOString();
                }

                // 处理数据
                if (!obj.isDelete && res.value.value.length > 0) {
                    try {
                        obj.data = JSON.parse(res.value.value.toString('utf8'));
                    } catch (e) {
                        obj.data = res.value.value.toString('utf8');
                    }
                }
                results.push(obj);
            }
            res = await iterator.next();
        }
        await iterator.close();
        return JSON.stringify(results);
    }

    // ============================================================
    // 5. 辅助与查询
    // ============================================================

    /**
     * 管理员查看企业用户及其权限
     * 权限：仅企业管理员可调用
     */
    async GetEnterpriseUsers(ctx) {
        // 角色检查：必须是管理员
        if (this._getCallerRole(ctx) !== "ADMIN") {
            throw new Error("权限拒绝：只有企业管理员可以查看企业用户");
        }

        const callerId = ctx.clientIdentity.getID();

        // LevelDB: 全局扫描 Enterprise 查找 adminId 匹配
        // 注意：由于未建立二级索引，需全表扫描。生产环境建议建立 CompositeKey 索引
        const iterator = await ctx.stub.getStateByRange('', '');
        let enterprise = null;
        let res = await iterator.next();

        while (!res.done) {
            if (res.value && res.value.value.toString()) {
                try {
                    const ent = JSON.parse(res.value.value.toString('utf8'));
                    if (ent.docType === DOC_TYPE_ENTERPRISE && ent.adminId === callerId) {
                        enterprise = ent;
                        break;
                    }
                } catch (e) { }
            }
            res = await iterator.next();
        }
        await iterator.close();

        if (!enterprise) {
            throw new Error("未找到您管理的企业");
        }

        // LevelDB: 扫描 USER_ 前缀查找 enterpriseId 匹配
        const userIterator = await ctx.stub.getStateByRange("USER_", "USER_\uffff");
        const users = [];
        let userRes = await userIterator.next();

        while (!userRes.done) {
            if (userRes.value && userRes.value.value.toString()) {
                try {
                    const user = JSON.parse(userRes.value.value.toString('utf8'));
                    if (user.docType === DOC_TYPE_USER && user.enterpriseId === enterprise.id) {
                        users.push({
                            userId: user.id,
                            permissions: user.permissions,
                            updateTime: user.updateTime
                        });
                    }
                } catch (e) { }
            }
            userRes = await userIterator.next();
        }
        await userIterator.close();

        return JSON.stringify({
            enterpriseId: enterprise.id,
            enterpriseName: enterprise.country, // 假设用country作为名称
            users: users
        });
    }

    /**
     * 测试接口：获取所有企业组织（忽略权限）
     */
    async TestGetAllEnterprises(ctx) {
        // LevelDB: 扫描所有并过滤 DOC_TYPE_ENTERPRISE
        const iterator = await ctx.stub.getStateByRange('', '');
        const enterprises = [];
        let res = await iterator.next();

        while (!res.done) {
            if (res.value && res.value.value.toString()) {
                try {
                    const val = JSON.parse(res.value.value.toString('utf8'));
                    if (val.docType === DOC_TYPE_ENTERPRISE) {
                        enterprises.push(val);
                    }
                } catch (e) { }
            }
            res = await iterator.next();
        }
        await iterator.close();
        return JSON.stringify(enterprises);
    }

    /**
     * 测试接口：获取指定企业的成员信息（忽略权限）
     */
    async TestGetUsersByEnterprise(ctx, entId) {
        if (!entId || String(entId).length === 0) throw new Error("entId 不能为空");

        // LevelDB: 扫描 USER_ 前缀并过滤 enterpriseId
        const userIterator = await ctx.stub.getStateByRange("USER_", "USER_\uffff");
        const users = [];
        let res = await userIterator.next();

        while (!res.done) {
            if (res.value && res.value.value.toString()) {
                try {
                    const user = JSON.parse(res.value.value.toString('utf8'));
                    if (user.docType === DOC_TYPE_USER && user.enterpriseId === entId) {
                        users.push({
                            userId: user.id,
                            permissions: user.permissions,
                            updateTime: user.updateTime
                        });
                    }
                } catch (e) { }
            }
            res = await userIterator.next();
        }
        await userIterator.close();

        return JSON.stringify({
            enterpriseId: entId,
            users: users
        });
    }

    /**
     * 用户查看自己的身份信息、企业信息和权限
     */
    async GetUserIdentity(ctx) {
        // 获取调用者ID
        const callerId = ctx.clientIdentity.getID();

        // 查询用户资产
        const userKey = "USER_" + callerId;
        const userBytes = await ctx.stub.getState(userKey);
        if (!userBytes || userBytes.length === 0) {
            throw new Error("用户不存在");
        }
        const user = JSON.parse(userBytes.toString());

        // 查询企业资产
        const entBytes = await ctx.stub.getState(user.enterpriseId);
        if (!entBytes || entBytes.length === 0) {
            throw new Error("企业不存在");
        }
        const enterprise = JSON.parse(entBytes.toString());

        return JSON.stringify({
            userId: user.id,
            enterprise: {
                id: enterprise.id,
                country: enterprise.country,
                scale: enterprise.scale,
                maxPermissions: enterprise.maxPermissions
            },
            permissions: user.permissions,
            updateTime: user.updateTime
        });
    }

    /**
     * 辅助工具：获取当前调用者的 X509 ID
     */
    async GetMyID(ctx) {
        const id = ctx.clientIdentity.getID();
        return JSON.stringify({ id });
    }

    /**
     * 查看链码基本信息
     */
    async help(ctx) {
        const info = {
            chaincodeName: "RSIdentity",
            type: "Identity & Compliance Oracle",
            version: "1.2",
            description: "完全支持leveldb",
            interfaces: [
                "RegisterEnterprise(entId, country, maxPerms, scale, adminId)",
                "RegisterUser(targetUserId, entId, perms)",
                "UpdateUserPermissions(targetUserId, entId, perms)",
                "CheckCompliance(userId, reqPerm, minScore, allowedCountries)",
                "GetEnterpriseHistory(entId)",
                "GetUserHistory(userId)",
                "IncrementTxCount(userId)",
                "GetEnterpriseUsers()",
                "TestGetAllEnterprises()",
                "TestGetUsersByEnterprise(entId)",
                "GetUserIdentity()",
                "GetMyID(ctx)"
            ]
        };
        return JSON.stringify(info, null, 2);
    }
}

module.exports = RSIdentity;
