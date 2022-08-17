import { check } from "../src/main";

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
};

const info = (info: string) => console.log(`INFO: ${info}`);
const warn = (warn: string) => console.log(`WARN: ${warn}`);

describe("test check()", () => {
  test("empty files and empty approvals", () => {
    expect(check(reviewers, [], [], info, warn)).toBe(true);
    expect(check(reviewers, [], ["anyone"], info, warn)).toBe(true);
    expect(check(reviewers, [], ["user1"], info, warn)).toBe(true);
  });

  test("any file requires 'test' reviewer", () => {
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
