export interface GitHubRepository {
  id: string;
  host: string;
  owner: string;
  name: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface GitHubIssuesResponse {
  repositories: GitHubRepository[];
  repository: GitHubRepository | null;
  issues: GitHubIssue[];
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface GitHubIssueDetails extends GitHubIssue {
  author: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: GitHubIssueComment[];
}

export interface GitHubIssueDetailsResponse { issue: GitHubIssueDetails }
export interface GitHubIssuesError { error: string; code: string }
