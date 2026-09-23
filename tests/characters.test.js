/*!
 * characters.test.js - promod's rules for who wears what.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const CH = require("../js/ui/characters.js");

const defs = { mp5_mp: { playerAnimType: "smg" }, m40a3_mp: { playerAnimType: "sniper" },
               ak47_mp: { playerAnimType: "autorifle" } };

describe("characters", () => {
  it("reads the side a player was on at a moment, across the half time swap", () => {
    const sides = { 3: [[0, "allies"], [900000, "axis"]] };
    assert.equal(CH.sideAt(sides, 3, 5000), "allies");
    assert.equal(CH.sideAt(sides, 3, 950000), "axis");
    assert.equal(CH.sideAt(sides, 9, 5000), null);
  });

  it("classes weapons the way promod's playerModelForWeapon does", () => {
    assert.equal(CH.classOfWeapon("mp5_mp", defs), "SPECOPS");
    assert.equal(CH.classOfWeapon("m40a3_mp", defs), "SNIPER");
    assert.equal(CH.classOfWeapon("m1014_mp", defs), "RECON");
    assert.equal(CH.classOfWeapon("ak47_mp", defs), "ASSAULT");
  });

  it("finds the primary weapon, ignoring sidearms and grenades", () => {
    const files = ["mp5_mp", "usp_mp", "frag_grenade_mp"];
    const track = [];
    for (let i = 0; i < 10; i++) track.push([i, 0, 0, 0, 0, 1]);   // usp mostly
    for (let i = 10; i < 13; i++) track.push([i, 0, 0, 0, 0, 0]);  // mp5
    track.push([13, 0, 0, 0, 0, 2]);
    assert.equal(CH.primaryWeapon(track, 0, 100, files), "mp5_mp");
  });

  it("dresses a player from map, side and class", () => {
    const spec = {
      maps: { mp_crash: { allies: "desert", axis: "desert" } },
      sets: { desert: { allies: { ASSAULT: "usmc_assault", SPECOPS: "usmc_specops" },
                        axis: { ASSAULT: "arab_assault", SPECOPS: "arab_cqb" } } }
    };
    const model = { sides: { 1: [[0, "axis"]] }, weaponFiles: ["mp5_mp"],
                    tracks: { 1: [[100, 0, 0, 0, 0, 0], [200, 0, 0, 0, 0, 0]] } };
    const round = { startS: 0, durS: 10 };
    assert.equal(CH.characterFor(spec, model, "mp_crash", 1, round, defs), "arab_cqb");
  });
});
