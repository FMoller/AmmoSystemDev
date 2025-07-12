/*:
 * @plugindesc A combined ammo system for dynamic damage, animation, and consumption.
 * @author Frederico Moeller & Gemini
 *
 * @param ammoTypeVariables
 * @type struct<AmmoVariable>[]
 * @text Ammo Type Variables
 * @desc Define which game variable holds the selected item ID for each ammo type (e.g., Arrow -> Var 10).
 *
 * @help
 * ============================================================================
 * Introduction
 * ============================================================================
 * This plugin implements a complete ammo system that allows for:
 * 1. Dynamic damage modification based on the equipped ammo.
 * 2. Dynamic animation switching based on the equipped ammo.
 * 3. Applying one or more status effects from special ammo.
 * 4. Changing the attack's element type based on the ammo.
 * 5. Modifying the attack's hit and critical rate based on weapon and ammo.
 * 6. Ammo consumption for basic attacks and specific skills.
 * 7. Skills that are less effective without ammo.
 * 8. Multi-shot skills that calculate a single powerful damage bonus.
 *
 * ============================================================================
 * Notetags
 * ============================================================================
 *
 * Weapon Notetags:
 * <Ammo: ammotype>
 * - Specifies the type of ammo the weapon uses (e.g., <Ammo: Arrow>).
 *
 * <DefaultWeaponId: id>
 * - Uses another weapon from the database as the base for this weapon's
 * stats and properties in combat. The <RangedHit> and <RangedCrit> tags
 * should be placed on this default weapon if this tag is used.
 *
 * <RangedHit: value>
 * - Adds a percentage bonus to hit rate ONLY when ammo is used.
 *
 * <RangedCrit: value>
 * - Adds a percentage bonus to critical hit rate ONLY when ammo is used.
 *
 * Item (Ammo) Notetags:
 * <Ammo: ammotype>
 * - Marks the item as a specific type of ammo.
 *
 * <AmmoAtk: value>
 * - Adds a flat amount to the actor's ATK for the attack.
 *
 * <AmmoAnimation: id>
 * - Overrides the weapon's animation for a basic attack.
 *
 * <AmmoState: id;chance>
 * - Gives the attack a chance to inflict a state on the target. You can have
 * multiple of these tags on a single ammo item.
 *
 * <AmmoDmgType: id>
 * - Changes the element of the attack.
 *
 * <AmmoHitRate: value>
 * - Adds a percentage bonus to the ammo's hit rate.
 *
 * <AmmoCrit: value>
 * - Adds a percentage bonus to the ammo's critical hit rate.
 *
 * Skill Notetags:
 * <UseAmmo>
 * - Add this to a skill's notebox to make it consume ammo.
 *
 * <StrictAmmo: value>
 * - If the actor has no ammo, the skill's success chance drops to this value.
 *
 * <MultiShot: count>
 * - Simulates firing up to 'count' shots. This affects the damage bonus and
 * the number of chances to apply status effects. Consumes all shots at once.
 * - This does NOT change the hit chance of the skill itself.
 * - Example: <MultiShot: 5>
 *
 * <NoAmmoAnimation: id>
 * - If a skill requires ammo but the player has none, this animation will
 * play instead of the skill's default animation.
 *
 * <LowAmmoAnimation: Q;id>
 * - For MultiShot skills only. If current ammo is less than Q, plays animation id.
 * - Q must be less than the MultiShot count.
 * - NoAmmoAnimation takes priority if ammo is zero.
 * - Example: <LowAmmoAnimation: 5;120>
 *
 */

/*~struct~AmmoVariable:
 * @param ammoType
 * @type string
 * @text Ammo Type
 * @desc The ammo type string (e.g., "Arrow", "Bolt") from weapon/item notes. Case-sensitive.
 * @param variableId
 * @type variable
 * @text Game Variable ID
 * @desc The ID of the Game Variable to store the selected item ID for this ammo type.
 */

var AmmoSystem = AmmoSystem || {};
AmmoSystem.Plugin_Name = "AmmoSystemDev"; // This name must match your plugin's filename

(function() {
    'use strict';

    const parameters = PluginManager.parameters(AmmoSystem.Plugin_Name);
    AmmoSystem._ammoTypeVariables = JSON.parse(parameters['ammoTypeVariables'] || '[]').map(entry => {
        const parsed = JSON.parse(entry);
        return {
            ammoType: String(parsed.ammoType || ''),
            variableId: Number(parsed.variableId || 0)
        };
    });

    // --- Utility Functions ---

    AmmoSystem.getVariableIdForAmmoType = function(ammoType) {
        const entry = this._ammoTypeVariables.find(e => e.ammoType === ammoType);
        return entry ? entry.variableId : null;
    };

    AmmoSystem.getNotetagValue = function(note, tagName) {
        if (!note) return null;
        const regex = new RegExp(`<${tagName}:\\s*(.+?)>`, 'i');
        const match = note.match(regex);
        return match ? match[1].trim() : null;
    };

    AmmoSystem.getNotetagNumber = function(note, tagName) {
        const value = this.getNotetagValue(note, tagName);
        return value !== null ? Number(value) : null;
    };
    
    AmmoSystem.getNotetagStateInfo = function(note) {
        const regex = /<AmmoState:\s*(\d+)\s*;\s*(\d+)\s*>/gi;
        const states = [];
        let match;
        while ((match = regex.exec(note)) !== null) {
            const stateId = Number(match[1]);
            const chance = Number(match[2]);
            if (!isNaN(stateId) && !isNaN(chance)) {
                states.push({ id: stateId, chance: chance / 100 });
            }
        }
        return states;
    };

    AmmoSystem.getNotetagLowAmmoAnimInfo = function(note) {
        const value = this.getNotetagValue(note, "LowAmmoAnimation");
        if (!value) return null;
        const parts = value.split(';');
        if (parts.length !== 2) return null;
        
        const quantity = Number(parts[0].trim());
        const animId = Number(parts[1].trim());
        
        if (isNaN(quantity) || isNaN(animId)) return null;
        
        return { quantity: quantity, animId: animId };
    };

    AmmoSystem.findBestMatchingAmmoItem = function(requiredAmmoType) {
        return $gameParty.items().find(item => {
            if (item && DataManager.isItem(item)) {
                return this.getNotetagValue(item.note, "Ammo") === requiredAmmoType;
            }
            return false;
        });
    };

    AmmoSystem.hasValidAmmo = function(actor, weaponAmmoType) {
        const variableId = this.getVariableIdForAmmoType(weaponAmmoType);
        if (!variableId) return true;

        let ammoId = $gameVariables.value(variableId);
        let ammoItem = ammoId > 0 ? $dataItems[ammoId] : null;

        if (ammoItem && this.getNotetagValue(ammoItem.note, "Ammo") === weaponAmmoType && $gameParty.hasItem(ammoItem)) {
            return true;
        }
        return !!this.findBestMatchingAmmoItem(weaponAmmoType);
    };

    AmmoSystem.ensureValidAmmoSelected = function(actor, weaponAmmoType) {
        const variableId = this.getVariableIdForAmmoType(weaponAmmoType);
        if (!variableId) return null;

        let ammoId = $gameVariables.value(variableId);
        let ammoItem = ammoId > 0 ? $dataItems[ammoId] : null;

        if (ammoItem && this.getNotetagValue(ammoItem.note, "Ammo") === weaponAmmoType && $gameParty.hasItem(ammoItem)) {
            return ammoItem;
        }

        const bestAmmo = this.findBestMatchingAmmoItem(weaponAmmoType);
        $gameVariables.setValue(variableId, bestAmmo ? bestAmmo.id : 0);
        return bestAmmo;
    };


    // --- Game_Actor Modifications ---

    const _Game_Actor_initMembers = Game_Actor.prototype.initMembers;
    Game_Actor.prototype.initMembers = function() {
        _Game_Actor_initMembers.apply(this, arguments);
        this._battleWeapon = null;
        this._originalWeaponData = null;
        this._tempAmmoAtk = 0;
        this._tempAmmoStateInfo = [];
        this._tempAmmoElementId = null;
        this._tempRangedHit = 0;
        this._tempAmmoHit = 0;
        this._tempRangedCrit = 0;
        this._tempAmmoCrit = 0;
        this._isApplyingTempAmmoParams = false;
        this._ammoToConsumeCount = 0;
    };

    const _Game_Actor_paramPlus = Game_Actor.prototype.paramPlus;
    Game_Actor.prototype.paramPlus = function(paramId) {
        let value = _Game_Actor_paramPlus.apply(this, arguments);
        if (this._isApplyingTempAmmoParams && paramId === 2) {
            value += this._tempAmmoAtk;
        }
        return value;
    };

    const _Game_Actor_xparam = Game_Actor.prototype.xparam;
    Game_Actor.prototype.xparam = function(xparamId) {
        let value = _Game_Actor_xparam.apply(this, arguments);
        if (this._isApplyingTempAmmoParams) {
            if (xparamId === 0) { // HIT
                value += this._tempRangedHit + this._tempAmmoHit;
            }
            if (xparamId === 2) { // CRI
                value += this._tempRangedCrit + this._tempAmmoCrit;
            }
        }
        return value;
    };

    const _Game_Actor_weapons = Game_Actor.prototype.weapons;
    Game_Actor.prototype.weapons = function() {
        if ($gameParty.inBattle() && this._battleWeapon) {
            const realWeapons = _Game_Actor_weapons.apply(this, arguments);
            if (realWeapons.length > 0) {
                return [this._battleWeapon].concat(realWeapons.slice(1));
            }
        }
        return _Game_Actor_weapons.apply(this, arguments);
    };

    Game_Actor.prototype.setupBattleWeapon = function() {
        const weapon = _Game_Actor_weapons.apply(this, arguments)[0];
        if (!weapon) {
            this._battleWeapon = null;
            this._originalWeaponData = null;
            return;
        }
        const defaultId = AmmoSystem.getNotetagNumber(weapon.note, "DefaultWeaponId");
        const baseWeapon = defaultId ? $dataWeapons[defaultId] : weapon;

        this._originalWeaponData = JSON.parse(JSON.stringify(baseWeapon));
        this._battleWeapon = JSON.parse(JSON.stringify(baseWeapon));
    };

    Game_Actor.prototype.applyAmmoEffects = function(ammoItem, action) {
        if (!ammoItem) return;

        const baseWeaponForAction = this._battleWeapon;
        let ammoToConsume = 1;
        let baseAmmoAtk = AmmoSystem.getNotetagNumber(ammoItem.note, "AmmoAtk") || 0;
        const baseStates = AmmoSystem.getNotetagStateInfo(ammoItem.note);
        let finalStates = [];
        let finalAmmoHitBonus = (AmmoSystem.getNotetagNumber(ammoItem.note, "AmmoHitRate") || 0) / 100;
        let finalAmmoCritBonus = (AmmoSystem.getNotetagNumber(ammoItem.note, "AmmoCrit") || 0) / 100;

        // --- MultiShot Calculation ---
        const multiShotCount = AmmoSystem.getNotetagNumber(action.item().note, "MultiShot");
        if (multiShotCount > 0) {
            const numInInventory = $gameParty.numItems(ammoItem);
            const numShots = Math.min(multiShotCount, numInInventory);
            
            if (numShots > 0) {
                // ATK Bonus Calculation
                const skillSuccessRate = action.item().successRate / 100;
                const baseHit = this.xparam(0);
                const rangedHitBonus = (AmmoSystem.getNotetagNumber(baseWeaponForAction.note, "RangedHit") || 0) / 100;
                const ammoHitBonusForSim = (AmmoSystem.getNotetagNumber(ammoItem.note, "AmmoHitRate") || 0) / 100;
                let singleShotHitChance = (baseHit + rangedHitBonus + ammoHitBonusForSim) * skillSuccessRate;
                singleShotHitChance = Math.max(0.01, Math.min(0.95, singleShotHitChance));
                const probOfAllMiss = Math.pow(1 - singleShotHitChance, numShots);
                const probAtLeastOneHit = 1 - probOfAllMiss;
                this._tempAmmoAtk = Math.round(numShots * baseAmmoAtk * probAtLeastOneHit);
                
                // State Application Calculation
                if (baseStates.length > 0) {
                    for (let i = 0; i < numShots; i++) {
                        finalStates = finalStates.concat(baseStates);
                    }
                }

                // Hit Rate Bonus Calculation
                const initialHitRate = AmmoSystem.getNotetagNumber(ammoItem.note, "AmmoHitRate") || 0;
                if (initialHitRate > 0) {
                    let hitRateModifier = 0.75;
                    const lowAmmoAnimInfo = AmmoSystem.getNotetagLowAmmoAnimInfo(action.item().note);
                    if (lowAmmoAnimInfo && $gameParty.numItems(ammoItem) < lowAmmoAnimInfo.quantity) {
                        hitRateModifier = 0.5;
                    }
                    const a = initialHitRate * hitRateModifier;
                    if (a > 0) {
                        const r = 0.5;
                        const totalBonus = a * (1 - Math.pow(r, numShots)) / (1 - r);
                        finalAmmoHitBonus = totalBonus / 100;
                    } else {
                        finalAmmoHitBonus = 0;
                    }
                }
                
                // Critical Rate Bonus Calculation
                const initialCritRate = AmmoSystem.getNotetagNumber(ammoItem.note, "AmmoCrit") || 0;
                if (initialCritRate > 0) {
                    let critRateModifier = 0.5;
                    const lowAmmoAnimInfo = AmmoSystem.getNotetagLowAmmoAnimInfo(action.item().note);
                    if (lowAmmoAnimInfo && $gameParty.numItems(ammoItem) < lowAmmoAnimInfo.quantity) {
                        critRateModifier = 0.33;
                    }
                    const a = initialCritRate * critRateModifier;
                    if (a > 0) {
                        const r = 0.5;
                        const totalBonus = a * (1 - Math.pow(r, numShots)) / (1 - r);
                        finalAmmoCritBonus = totalBonus / 100;
                    } else {
                        finalAmmoCritBonus = 0;
                    }
                }

                ammoToConsume = numShots;
            }
        } else {
            this._tempAmmoAtk = baseAmmoAtk;
            finalStates = baseStates;
        }
        
        this._ammoToConsumeCount = ammoToConsume;
        this._tempAmmoStateInfo = finalStates;
        this._tempAmmoHit = finalAmmoHitBonus;
        this._tempAmmoCrit = finalAmmoCritBonus;
        
        this._tempRangedHit = (AmmoSystem.getNotetagNumber(baseWeaponForAction.note, "RangedHit") || 0) / 100;
        this._tempRangedCrit = (AmmoSystem.getNotetagNumber(baseWeaponForAction.note, "RangedCrit") || 0) / 100;
        this._tempAmmoElementId = AmmoSystem.getNotetagNumber(ammoItem.note, "AmmoDmgType");
        
        this._isApplyingTempAmmoParams = true;
    };

    Game_Actor.prototype.resetAmmoEffects = function() {
        if (this._originalWeaponData) {
             this._battleWeapon = JSON.parse(JSON.stringify(this._originalWeaponData));
        }
        
        this._tempAmmoAtk = 0;
        this._tempAmmoStateInfo = [];
        this._tempAmmoElementId = null;
        this._tempRangedHit = 0;
        this._tempAmmoHit = 0;
        this._tempRangedCrit = 0;
        this._tempAmmoCrit = 0;
        this._ammoToConsumeCount = 0;
        this._isApplyingTempAmmoParams = false;
    };


    // --- BattleManager Hooks ---

    const _BattleManager_setup = BattleManager.setup;
    BattleManager.setup = function(troopId, canEscape, canLose) {
        _BattleManager_setup.apply(this, arguments);
        $gameParty.members().forEach(actor => actor.setupBattleWeapon());
    };

    const _BattleManager_startAction = BattleManager.startAction;
    BattleManager.startAction = function() {
        _BattleManager_startAction.apply(this, arguments);

        const subject = this._subject;
        if (subject && subject.isActor()) {
            const action = subject.currentAction();
            const weapon = subject.weapons()[0];
            if (action && weapon) {
                const weaponAmmoType = AmmoSystem.getNotetagValue(weapon.note, "Ammo");
                const actionNote = action.item().note || "";
                const isAmmoAction = action.isAttack() || actionNote.includes('<UseAmmo>') || actionNote.includes('<StrictAmmo') || actionNote.includes('<MultiShot');

                if (weaponAmmoType && isAmmoAction) {
                    const ammoToUse = AmmoSystem.ensureValidAmmoSelected(subject, weaponAmmoType);
                    subject.resetAmmoEffects();
                    
                    if (ammoToUse) {
                        subject.applyAmmoEffects(ammoToUse, action);
                        
                        // --- UNIFIED ANIMATION LOGIC ---
                        if (action.isAttack()) {
                            const ammoAnimId = AmmoSystem.getNotetagNumber(ammoToUse.note, "AmmoAnimation");
                            if (ammoAnimId && subject._battleWeapon) {
                                subject._battleWeapon.animationId = ammoAnimId;
                            }
                        } else if (action.isSkill()) {
                            let animationIdToUse = 0;
                            const multiShotCount = AmmoSystem.getNotetagNumber(action.item().note, "MultiShot");
                            const lowAmmoAnimInfo = AmmoSystem.getNotetagLowAmmoAnimInfo(action.item().note);
                            
                            if (multiShotCount > 0 && lowAmmoAnimInfo && lowAmmoAnimInfo.quantity < multiShotCount) {
                                const currentAmmoCount = $gameParty.numItems(ammoToUse);
                                if (currentAmmoCount < lowAmmoAnimInfo.quantity) {
                                    animationIdToUse = lowAmmoAnimInfo.animId;
                                }
                            }
                            
                            if (animationIdToUse > 0) {
                                action._overrideAnimationId = animationIdToUse;
                            }
                        }

                    } else {
                        // No ammo, only applies to skills
                        if (action.isSkill()) {
                            const noAmmoAnimId = AmmoSystem.getNotetagNumber(action.item().note, "NoAmmoAnimation");
                            if (noAmmoAnimId) {
                                action._overrideAnimationId = noAmmoAnimId;
                            }
                        }
                    }

                    // --- DEBUG LOG ---
                    //console.log("--- AMMO SYSTEM ACTION START ---");
                    //console.log("Action:", action.item().name);
                    //console.log("Actor Base ATK:", subject.paramBase(2));
                    //console.log("Ammo ATK Bonus:", subject._tempAmmoAtk);
                    //console.log("Effective HIT:", (subject.xparam(0) * 100).toFixed(2) + "%");
                    //console.log("Effective CRI:", (subject.xparam(2) * 100).toFixed(2) + "%");
                    //let elementId = subject._tempAmmoElementId !== null ? subject._tempAmmoElementId : action.item().damage.elementId;
                    //if (elementId < 0) {
                    //    elementId = subject.attackElementId();
                    //}
                    //console.log("Attack Element:", $dataSystem.elements[elementId]);
                    //if (actionNote.includes('<MultiShot')) {
                    //   console.log("Ammo to Consume:", subject._ammoToConsumeCount);
                    //}
                    //console.log("---------------------------------");
                }
            }
        }
    };

    const _BattleManager_endAction = BattleManager.endAction;
    BattleManager.endAction = function() {
        const action = this._action;
        if (action && action._overrideAnimationId) {
            action._overrideAnimationId = 0; // Reset it
        }
        
        _BattleManager_endAction.apply(this, arguments);
        const subject = this._subject;
        if (subject && subject.isActor() && subject._isApplyingTempAmmoParams) {
            subject.resetAmmoEffects();
        }
    };

    // --- Game_Action Hooks ---

    const _Game_Action_animationId = Game_Action.prototype.animationId;
    Game_Action.prototype.animationId = function() {
        if (this._overrideAnimationId > 0) {
            return this._overrideAnimationId;
        }
        return _Game_Action_animationId.apply(this, arguments);
    };

    const _Game_Action_numRepeats = Game_Action.prototype.numRepeats;
    Game_Action.prototype.numRepeats = function() {
        const multiShotCount = AmmoSystem.getNotetagNumber(this.item().note, "MultiShot");
        if (multiShotCount > 0) {
            return 1;
        }
        return _Game_Action_numRepeats.apply(this, arguments);
    };

    const _Game_Action_itemHit = Game_Action.prototype.itemHit;
    Game_Action.prototype.itemHit = function(target) {
        const subject = this.subject();
        if (subject && subject.isActor() && this.isSkill()) {
            const strictAmmoValue = AmmoSystem.getNotetagNumber(this.item().note, "StrictAmmo");
            if (strictAmmoValue !== null) {
                const weapon = subject.weapons()[0];
                if (weapon) {
                    const weaponAmmoType = AmmoSystem.getNotetagValue(weapon.note, "Ammo");
                    if (weaponAmmoType && !AmmoSystem.hasValidAmmo(subject, weaponAmmoType)) {
                        return strictAmmoValue / 100;
                    }
                }
            }
        }
        return _Game_Action_itemHit.apply(this, arguments);
    };

    const _Game_Action_calcElementRate = Game_Action.prototype.calcElementRate;
    Game_Action.prototype.calcElementRate = function(target) {
        const subject = this.subject();
        if (subject && subject.isActor() && subject._isApplyingTempAmmoParams) {
            const ammoElementId = subject._tempAmmoElementId;
            if (ammoElementId !== null && ammoElementId >= 0) {
                return target.elementRate(ammoElementId);
            }
        }
        return _Game_Action_calcElementRate.apply(this, arguments);
    };

    const _Game_Action_apply = Game_Action.prototype.apply;
    Game_Action.prototype.apply = function(target) {
        _Game_Action_apply.apply(this, arguments);

        const subject = this.subject();
        if (subject && subject.isActor() && subject._isApplyingTempAmmoParams) {
            if (target.result().isHit()) {
                // Apply states
                if (subject._tempAmmoStateInfo.length > 0 && target.isEnemy() && target.isAlive()) {
                    subject._tempAmmoStateInfo.forEach(stateInfo => {
                        if (Math.random() < stateInfo.chance) {
                            target.addState(stateInfo.id);
                        }
                    });
                }
                // Consume ammo
                if (subject._ammoToConsumeCount > 0) {
                    const weapon = subject.weapons()[0];
                    if (weapon) {
                       const ammoItem = AmmoSystem.ensureValidAmmoSelected(subject, AmmoSystem.getNotetagValue(weapon.note, "Ammo"));
                        if (ammoItem) {
                            $gameParty.loseItem(ammoItem, subject._ammoToConsumeCount);
                        } 
                    }
                    subject._ammoToConsumeCount = 0; // Consume only once per action
                }
            } else {
                subject._ammoToConsumeCount = 0;
            }
        }
    };
    
    // --- Window_BattleLog Hook ---
    
    const _Window_BattleLog_showAnimation = Window_BattleLog.prototype.showAnimation;
    Window_BattleLog.prototype.showAnimation = function(subject, targets, animationId) {
        const action = BattleManager._action;
        // If the current action has our override property, use it instead.
        if (action && action._overrideAnimationId > 0) {
            animationId = action._overrideAnimationId;
        }
        _Window_BattleLog_showAnimation.call(this, subject, targets, animationId);
    };

    const _BattleManager_endBattle = BattleManager.endBattle;
    BattleManager.endBattle = function() {
        _BattleManager_endBattle.apply(this, arguments);
        $gameParty.members().forEach(actor => {
            actor._battleWeapon = null;
            actor._originalWeaponData = null;
            actor.resetAmmoEffects();
        });
    };

})();
