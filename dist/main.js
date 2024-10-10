"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const core = __importStar(require("@actions/core"));
const openai_1 = __importDefault(require("openai"));
const rest_1 = require("@octokit/rest");
const parse_diff_1 = __importDefault(require("parse-diff"));
const minimatch_1 = require("minimatch");
// Constants for AI configuration
const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL = core.getInput("OPENAI_API_MODEL");
const REVIEW_COMMENT_PREFIX = core.getInput("review_comment_prefix") || "";
const MAX_TOKENS = parseInt(core.getInput("max_tokens") || '16000', 10); // Default 700
const MAX_FILES = parseInt(core.getInput("max_files") || '10', 10); // Default 5
const AI_REVIEWER_NAME = "**AI Code Reviewer**";
const AI_ICON = '\uD83D\uDE80';
const ESTIMATED_TOKEN_LIMIT = 3800;
// AI configuration object
const AI_CONFIG = {
    temperature: 0.2,
    max_tokens: MAX_TOKENS,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
};
// Octokit and OpenAI client initialization
const octokit = new rest_1.Octokit({ auth: GITHUB_TOKEN });
const openai = new openai_1.default({ apiKey: OPENAI_API_KEY });
// Centralized error handling
const handleError = (error, context) => {
    if (error instanceof Error) {
        core.error(`Error during ${context}: ${error.message}`);
        core.error(error.stack || "No stack trace available");
    }
    else {
        core.error(`Error during ${context}: ${JSON.stringify(error)}`);
    }
};
// Fetch details of the pull request
const getPRDetails = (owner, repo, pull_number) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    try {
        const { data: prData } = yield octokit.pulls.get({
            owner,
            repo,
            pull_number,
        });
        return {
            owner,
            repo,
            pull_number,
            title: (_a = prData.title) !== null && _a !== void 0 ? _a : "",
            description: (_b = prData.body) !== null && _b !== void 0 ? _b : "",
        };
    }
    catch (error) {
        handleError(error, "getting PR details");
        throw error;
    }
});
// Get diff of the pull request
const getDiff = (owner, repo, pull_number) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { data } = yield octokit.pulls.get({
            owner,
            repo,
            pull_number,
            mediaType: { format: "diff" },
        });
        return String(data);
    }
    catch (error) {
        handleError(error, "getting diff");
        return null;
    }
});
// Get diff for synchronization event (between commits)
const getDiffForSync = (owner, repo, baseSha, headSha) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { data } = yield octokit.repos.compareCommits({
            owner,
            repo,
            base: baseSha,
            head: headSha,
            headers: {
                accept: "application/vnd.github.v3.diff",
            },
        });
        return String(data);
    }
    catch (error) {
        handleError(error, "getting diff for sync event");
        return null;
    }
});
// Function to truncate diffs by token limits
const truncateDiffByTokenLimit = (diff, maxTokens) => {
    const tokensPerChar = 1 / 4; // Approximation: 1 token ≈ 4 characters
    const maxChars = Math.floor(maxTokens / tokensPerChar);
    return diff.slice(0, maxChars);
};
// Generate AI prompt from diff and PR details
const createPrompt = (file, chunk, prDetails) => {
    const MAX_DIFF_LINES = 50;
    let codeDiff = chunk.changes
        .slice(0, MAX_DIFF_LINES) // Limit the number of changes sent to the AI
        .map((c) => { var _a; return `${(_a = c.ln) !== null && _a !== void 0 ? _a : c.ln2} ${c.content}`; })
        .join("\n");
    codeDiff = truncateDiffByTokenLimit(codeDiff, ESTIMATED_TOKEN_LIMIT); // Truncate if it exceeds token limit
    return `
    ### Task
    You are reviewing a pull request. Focus on providing specific and constructive feedback for the code changes in the following diff.

    ### Instructions:
    - Review only the code changes in the diff.
    - Suggest adding comments to the code only if they are critical or worth improving.
    - Suggest improvements related to formatting only if they enhance readability, maintainability, or adherence to established coding standards.
    - Provide feedback in the following JSON format:
      {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>"}]}
    - Only suggest improvements if there is something critical or worth improving. Otherwise, return an empty "reviews" array.
    - The pull request title and description are for context only. Comment only on the code changes.
    - Use concise GitHub Markdown format for comments.

    ### Context:
    - **Pull request title**: ${prDetails.title}
    - **Pull request description**: ${prDetails.description}

    ### Code Diff for File "${file.to}":
    \`\`\`diff
    ${chunk.content}
    ${codeDiff}
    \`\`\`
  `;
};
// Get AI response with a timeout to prevent indefinite waiting
const getAIResponse = (prompt_1, ...args_1) => __awaiter(void 0, [prompt_1, ...args_1], void 0, function* (prompt, timeoutMs = 15000) {
    const timeout = new Promise((resolve) => setTimeout(() => {
        core.warning("AI response timed out");
        resolve(null);
    }, timeoutMs));
    const aiResponsePromise = openai.chat.completions.create(Object.assign(Object.assign(Object.assign({}, AI_CONFIG), { model: OPENAI_API_MODEL, messages: [{ role: "system", content: prompt }] }), (OPENAI_API_MODEL === "gpt-4-1106-preview" ? { response_format: { type: "json_object" } } : {}))).then(response => {
        var _a, _b;
        const content = ((_b = (_a = response.choices[0]) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.content) || '{}';
        try {
            return JSON.parse(content).reviews || [];
        }
        catch (error) {
            core.warning(`Failed to parse AI response as JSON: ${error}`);
            return [];
        }
    }).catch(err => {
        core.warning(`AI request failed: ${err}`);
        return null;
    });
    return Promise.race([timeout, aiResponsePromise]);
});
// Create GitHub comments from AI response
const createComment = (file, aiResponses) => {
    return aiResponses.map(({ lineNumber, reviewComment }) => {
        var _a;
        return ({
            // body: `${AI_ICON} ${AI_REVIEWER_NAME}\n\n${REVIEW_COMMENT_PREFIX}\n\n${reviewComment}`,
            body: `hello`,
            path: (_a = file.to) !== null && _a !== void 0 ? _a : '',
            line: Number(lineNumber),
        });
    });
};
// Post review comments on the pull request
const createReviewComment = (owner, repo, pull_number, comments) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield octokit.pulls.createReview({
            owner,
            repo,
            pull_number,
            comments,
            event: "COMMENT",
        });
    }
    catch (error) {
        handleError(error, "posting review comment");
    }
});
// Analyze the code and collect AI-generated comments
// Analyze the code and collect AI-generated comments
const analyzeCode = (parsedDiff, prDetails) => __awaiter(void 0, void 0, void 0, function* () {
    const commentPromises = parsedDiff.flatMap(file => {
        if (!file.to || file.to === "/dev/null" || !file.chunks || file.chunks.length === 0) {
            return []; // Skip deleted, empty, or binary files
        }
        return file.chunks.map((chunk) => __awaiter(void 0, void 0, void 0, function* () {
            try {
                // Generate AI prompt and get the response
                const prompt = createPrompt(file, chunk, prDetails);
                const aiResponse = yield getAIResponse(prompt);
                // Ensure AI response is valid
                if (aiResponse && aiResponse.length > 0) {
                    // Create comments based on AI response
                    const newComments = createComment(file, aiResponse);
                    // Return comments if generated
                    return newComments.length > 0 ? newComments : [];
                }
                return []; // Return empty array if no AI response or comments
            }
            catch (error) {
                // Handle any errors during AI processing
                handleError(error, `processing file ${file.to}`);
                return []; // Return empty array on error
            }
        }));
    });
    // Await all promises and resolve them properly
    const resolvedComments = yield Promise.all(commentPromises);
    // Flatten and filter out empty comments
    return resolvedComments.flat().filter(comment => comment.body.trim() !== "");
});
// Function to detect binary files based on extensions
const isBinaryFile = (filePath) => {
    const binaryExtensions = [
        '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.exe', '.zip', '.tar', '.bz2', '.xz', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.webm',
        '.iso', '.dmg', '.jar', '.class', '.so', '.dll', '.bin', '.o', '.obj', '.woff', '.woff2', '.ttf', '.eot'
    ]; // Expanded list
    return binaryExtensions.some(ext => filePath.endsWith(ext));
};
// Exclude binary files
const excludeBinaryFiles = (files) => {
    return files.filter(file => { var _a; return !isBinaryFile((_a = file.to) !== null && _a !== void 0 ? _a : ''); });
};
// Fetch the diff based on event action
const fetchDiff = (eventData, prDetails) => __awaiter(void 0, void 0, void 0, function* () {
    if (eventData.action === "opened") {
        return getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
    }
    else if (eventData.action === "synchronize") {
        const { before: baseSha, after: headSha } = eventData;
        return getDiffForSync(prDetails.owner, prDetails.repo, baseSha, headSha);
    }
    core.warning(`Unsupported event type: ${eventData.action}. Supported actions are "opened" and "synchronize".`);
    return null;
});
// Filter the diff files and exclude binary files in a single step
const filterAndExcludeFiles = (files, excludePatterns) => {
    return excludeBinaryFiles(files.filter(file => !excludePatterns.some(pattern => { var _a; return (0, minimatch_1.minimatch)((_a = file.to) !== null && _a !== void 0 ? _a : "", pattern); }))).slice(0, MAX_FILES); // Filter out excluded patterns and binary files, then limit to MAX_FILES
};
// Main function to handle the PR review process
const main = () => __awaiter(void 0, void 0, void 0, function* () {
    var _c;
    try {
        const eventData = JSON.parse((0, fs_1.readFileSync)((_c = process.env.GITHUB_EVENT_PATH) !== null && _c !== void 0 ? _c : "", "utf8"));
        const { repository, number } = eventData;
        const prDetails = yield getPRDetails(repository.owner.login, repository.name, number);
        const diff = yield fetchDiff(eventData, prDetails);
        if (!diff) {
            core.info("No diff found for the pull request.");
            return;
        }
        const parsedDiff = (0, parse_diff_1.default)(diff);
        const excludePatterns = core.getMultilineInput("exclude").map(s => s.trim());
        // Filter the diff files and exclude binary files in a single step
        const filteredDiff = filterAndExcludeFiles(parsedDiff, excludePatterns);
        const comments = yield analyzeCode(filteredDiff, prDetails);
        if (comments.length > 0) {
            yield createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
        }
        else {
            core.info("No actionable comments generated by AI.");
        }
    }
    catch (error) {
        core.setFailed(`Action failed with error: ${error}`);
    }
});
main();
