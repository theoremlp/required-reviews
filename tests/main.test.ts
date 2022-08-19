import { check, checkOverride } from "../src/main";

const reviewers = {
  teams: {
    everyone: {
      users: ["user1", "user2"],
    },
  },
  reviewers: {
    "": {
      description: "user 'user1' required reviewer for all files",
      users: ["user1"],
      requiredApproverCount: 1,
    },
    ".github/": {
      description: ".github directory requires two reviews",
      users: ["user1", "user2"],
      requiredApproverCount: 2,
    },
    "team/": {
      description: "team directory requires two reviews",
      teams: ["everyone"],
      requiredApproverCount: 2,
    },
  },
  overrides: [
    {
      description: "allow user 'bot' to modify package.json and yarn.lock",
      onlyModifiedByUsers: ["bot"],
      onlyModifiedFileRegExs: ["package\\.json", "^yarn\\.lock$"],
    },
  ],
};

const info = (info: string) => console.log(`INFO: ${info}`);
const warn = (warn: string) => console.log(`WARN: ${warn}`);

describe("test check()", () => {
  test("empty files and empty approvals", () => {
    expect(check(reviewers, [], [], info, warn)).toBe(true);
    expect(check(reviewers, [], ["anyone"], info, warn)).toBe(true);
    expect(check(reviewers, [], ["user1"], info, warn)).toBe(true);
  });

  test("any file requires 'user1' reviewer", () => {
    expect(check(reviewers, ["file"], [], info, warn)).toBe(false);
    expect(check(reviewers, ["file"], ["anyone"], info, warn)).toBe(false);
    expect(check(reviewers, ["file"], ["user1"], info, warn)).toBe(true);
  });

  test("'.github/' files require 2 reviewers", () => {
    const files = [".github/foo"];
    expect(check(reviewers, files, [], info, warn)).toBe(false);
    expect(check(reviewers, files, ["user1"], info, warn)).toBe(false);
    expect(check(reviewers, files, ["user1", "user2"], info, warn)).toBe(true);
  });

  test("'team/' files require 2 reviewers", () => {
    const files = ["team/foo"];
    expect(check(reviewers, files, [], info, warn)).toBe(false);
    expect(check(reviewers, files, ["user1"], info, warn)).toBe(false);
    expect(check(reviewers, files, ["user1", "user2"], info, warn)).toBe(true);
  });
});

describe("test checkOverride()", () => {
  test("user 'bot' has override for package.json", () => {
    const files = ["package.json"];
    expect(checkOverride(reviewers.overrides, files, ["user1"])).toBe(false);
    expect(checkOverride(reviewers.overrides, files, ["bot"])).toBe(true);
  });

  test("user 'bot' has override for package.json in any directory", () => {
    const files = ["foo/bar/package.json"];
    expect(checkOverride(reviewers.overrides, files, ["user1"])).toBe(false);
    expect(checkOverride(reviewers.overrides, files, ["bot"])).toBe(true);
  });

  test("user 'bot' has override for yarn.lock only in root", () => {
    expect(checkOverride(reviewers.overrides, ["yarn.lock"], ["user1"])).toBe(
      false
    );
    expect(checkOverride(reviewers.overrides, ["yarn.lock"], ["bot"])).toBe(
      true
    );
    expect(
      checkOverride(reviewers.overrides, ["foo/bar/yarn.lock"], ["bot"])
    ).toBe(false);
  });
});
