import * as core from "@actions/core";
import * as github from "@actions/github";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import { minimatch } from "minimatch";

// Type for changes in diff
type TChangeType = {
  ln?: number;   // Line number in the new file
  ln2?: number;  // Line number in the old file (for unchanged lines)
  content: string;  // The content of the line in the diff
};

// Constants for AI configuration
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const REVIEW_COMMENT_PREFIX: string = core.getInput("review_comment_prefix") || "";
const MAX_TOKENS: number = parseInt(core.getInput("max_tokens") || '16000', 10);  // Default 700
const MAX_FILES: number = parseInt(core.getInput("max_files") || '10', 10);  // Default 5
const EXCLUDE_PATTERNS: string[] = core.getInput("exclude").split(',').map((s: string) => s.trim());
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
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Interface for pull request details
interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

// Centralized error handling
const handleError = (error: unknown, context: string) => {
  if (error instanceof Error) {
    core.error(`Error during ${context}: ${error.message}`);
    core.error(error.stack || "No stack trace available");
  } else {
    core.error(`Error during ${context}: ${JSON.stringify(error)}`);
  }
};

// Fetch details of the pull request
const getPRDetails = async (owner: string, repo: string, pull_number: number): Promise<PRDetails> => {
  try {
    const { data: prData } = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
    });

    return {
      owner,
      repo,
      pull_number,
      title: prData.title ?? "",
      description: prData.body ?? "",
    };
  } catch (error) {
    handleError(error, "getting PR details");
    throw error;
  }
};

// Get diff of the pull request
const getDiff = async (owner: string, repo: string, pull_number: number): Promise<string | null> => {
  try {
    const { data } = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
      mediaType: { format: "diff" },
    });
    return String(data);
  } catch (error) {
    handleError(error, "getting diff");
    return null;
  }
};

// Function to truncate diffs by token limits
const truncateDiffByTokenLimit = (diff: string, maxTokens: number): string => {
  const tokensPerChar = 1 / 4;  // Approximation: 1 token ≈ 4 characters
  const maxChars = Math.floor(maxTokens / tokensPerChar);
  return diff.slice(0, maxChars);
};

// Generate AI prompt from diff and PR details
const createPrompt = (file: File, chunk: Chunk, prDetails: PRDetails): string => {
  const MAX_DIFF_LINES = 50;
  let codeDiff = chunk.changes
    .slice(0, MAX_DIFF_LINES)  // Limit the number of changes sent to the AI
    .map((c: TChangeType) => `${c.ln ?? c.ln2} ${c.content}`)
    .join("\n");

  codeDiff = truncateDiffByTokenLimit(codeDiff, ESTIMATED_TOKEN_LIMIT);  // Truncate if it exceeds token limit

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
const getAIResponse = async (prompt: string): Promise<Array<{ lineNumber: string; reviewComment: string }> | null> => {
  try {
    const response = await openai.chat.completions.create({
      ...AI_CONFIG,
      model: OPENAI_API_MODEL,
      messages: [{ role: "system", content: prompt }],
      // Force JSON output for all models
      response_format: { type: "json_object" }
    });

    const content = response.choices[0]?.message?.content || '{}';

    try {
      // Parse the JSON directly
      return JSON.parse(content).reviews || [];
    } catch (error) {
      core.warning(`Failed to parse AI response as JSON: ${error}`);
      return [];
    }

  } catch (err) {
    core.warning(`AI request failed: ${err}`);
    return null;
  }
};

// Create GitHub comments from AI response
const createComment = (file: File, aiResponses: Array<{ lineNumber: string; reviewComment: string }>): Array<{ body: string; path: string; line: number }> => {
  return aiResponses.map(({ lineNumber, reviewComment }) => ({
    body: `${AI_ICON} ${AI_REVIEWER_NAME}\n\n${REVIEW_COMMENT_PREFIX}\n\n${reviewComment}`,
    path: file.to ?? '',
    line: Number(lineNumber),
  }));
};

// Post review comments on the pull request
const createReviewComment = async (owner: string, repo: string, pull_number: number, comments: Array<{ body: string; path: string; line: number }>): Promise<void> => {
  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments,
      event: "COMMENT",
    });
  } catch (error) {
    handleError(error, "posting review comment");
  }
};

// Update the BotComment interface
interface BotComment {
  id: number;
  path: string;
  position: number;
  body: string;
  original_line: number;
  original_content: string;
}

// Update getPreviousBotComments
const getPreviousBotComments = async (owner: string, repo: string, pull_number: number): Promise<BotComment[]> => {
  try {
    const { data: comments } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number
    });

    return comments
      .filter(comment => comment.user?.login === "github-actions[bot]" && comment.position !== undefined)
      .map(comment => ({
        id: comment.id,
        path: comment.path,
        position: comment.position as number,
        body: comment.body,
        original_line: comment.original_line as number,
        original_content: comment.diff_hunk?.split('\n').pop() ?? ''
      }));
  } catch (error) {
    handleError(error, "fetching previous bot comments");
    return [];
  }
};

// Update the analyzeCode function
const analyzeCode = async (parsedDiff: File[], prDetails: PRDetails): Promise<Array<{ body: string; path: string; line: number }>> => {
  const previousComments = await getPreviousBotComments(prDetails.owner, prDetails.repo, prDetails.pull_number);
  const newComments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (!file.to || file.to === "/dev/null" || !file.chunks || file.chunks.length === 0) {
      continue;  // Skip deleted, empty, or binary files
    }

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);

      if (aiResponse && aiResponse.length > 0) {
        const chunkComments = createComment(file, aiResponse);

        for (const newComment of chunkComments) {
          const existingComment = previousComments.find(prevComment =>
            prevComment.path === newComment.path &&
            prevComment.original_line === newComment.line
          );

          // Check if there's an existing comment on this line
          if (existingComment) {
            // If the existing comment is similar to the new one, skip it
            if (isSimilarComment(existingComment.body, newComment.body)) {
              continue;
            }
          }

          newComments.push(newComment);
        }
      }
    }
  }

  return newComments;
};

// Add a helper function to check if comments are similar
const isSimilarComment = (existingComment: string, newComment: string): boolean => {
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const existingNormalized = normalize(existingComment);
  const newNormalized = normalize(newComment);

  // Check if the comments are very similar (e.g., more than 80% similar)
  const similarity = stringSimilarity(existingNormalized, newNormalized);
  return similarity > 0.8;
};

// Add a simple string similarity function
const stringSimilarity = (s1: string, s2: string): number => {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  const longerLength = longer.length;
  if (longerLength === 0) {
    return 1.0;
  }
  return (longerLength - editDistance(longer, shorter)) / longerLength;
};

const editDistance = (s1: string, s2: string): number => {
  s1 = s1.toLowerCase();
  s2 = s2.toLowerCase();

  const costs = new Array();
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0)
        costs[j] = j;
      else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1))
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0)
      costs[s2.length] = lastValue;
  }
  return costs[s2.length];
};

// Function to detect binary files based on extensions
const isBinaryFile = (filePath: string): boolean => {
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.exe', '.zip', '.tar', '.bz2', '.xz', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.webm',
    '.iso', '.dmg', '.jar', '.class', '.so', '.dll', '.bin', '.o', '.obj', '.woff', '.woff2', '.ttf', '.eot'
  ];  // Expanded list
  return binaryExtensions.some(ext => filePath.endsWith(ext));
};

// Exclude binary files
const excludeBinaryFiles = (files: File[]): File[] => {
  return files.filter(file => !isBinaryFile(file.to ?? ''));
};

// always fetch the full PR diff
const fetchDiff = async (prDetails: PRDetails): Promise<string | null> => {
  return getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);  // Always fetch the full diff
};

// Filter the diff files and exclude binary files in a single step
const filterAndExcludeFiles = (files: File[], excludePatterns: string[]): File[] => {
  return excludeBinaryFiles(
    files.filter(file => {
      const filePath = file.to ?? '';
      // Ensure the file is not excluded by matching against the provided patterns
      return !excludePatterns.some(pattern => minimatch(filePath, pattern));
    })
  ).slice(0, MAX_FILES);  // Limit the files to MAX_FILES
};

const main = async () => {
  try {
    // Get the pull request number from the GitHub context
    const pullRequestNumber = github.context.payload.pull_request?.number;
    if (!pullRequestNumber) {
      throw new Error('This action can only be run on pull requests');
    }

    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    core.info(`Processing PR #${pullRequestNumber} for ${owner}/${repo}`);

    const prDetails = await getPRDetails(owner, repo, pullRequestNumber);
    core.info(`PR Details fetched: ${JSON.stringify(prDetails)}`);

    const diff = await fetchDiff(prDetails);

    if (!diff) {
      core.info("No diff found for the pull request.");
      return;
    }

    core.info(`Diff fetched, length: ${diff.length} characters`);

    const parsedDiff = parseDiff(diff);
    core.info(`Parsed diff, found ${parsedDiff.length} files`);

    const filteredDiff = filterAndExcludeFiles(parsedDiff, EXCLUDE_PATTERNS);
    core.info(`Filtered diff, ${filteredDiff.length} files remaining`);

    // Analyze the code and generate comments
    const comments = await analyzeCode(filteredDiff, prDetails);
    core.info(`Generated ${comments.length} new comments`);

    if (comments.length > 0) {
      await createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
      core.info("Posted new comments to the PR");
    } else {
      core.info("No new actionable comments generated by AI.");
    }

  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`);
  }
};

main();
