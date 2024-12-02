import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";


// Configuration variables
const config = new pulumi.Config();
const awsRegion = aws.config.region || "us-east-1"; 
const dbUsername = config.require("dbUsername");
const dbPassword = config.requireSecret("dbPassword");
const dbName = config.get("dbName") || "sampleprojectdb";
const identityPoolName =  config.get("identityPoolName") || "sample-project-identity-pool";
const projectName = pulumi.getProject();
const callbackUrls = ["https://localhost:3000/auth/callback"]; // Replace with your application's callback URLs
const logoutUrls = ["https://localhost:3000/logout"]; // Replace with your application's logout URLs
const awsAccountId = config.requireSecret("awsAccountId");

// Cognito User Pool with Email Verification Only
const userPool = new aws.cognito.UserPool(`${projectName}-userPool`, {
    autoVerifiedAttributes: ["email"], 
    emailConfiguration: {
        emailSendingAccount: "COGNITO_DEFAULT", // Use "DEVELOPER" for SES integration
    },    
    passwordPolicy: {
        minimumLength: 8,
        requireNumbers: true,
        requireSymbols: true,
        requireUppercase: true,
        requireLowercase: true,
    },
    verificationMessageTemplate: {
        defaultEmailOption: "CONFIRM_WITH_CODE", 
        emailSubject: "Verify your email to view the sample project",
        emailMessage: "Your verification code for np's sample project is {####}", 
    },
});


// Cognito User Pool Domain
const userPoolDomain = new aws.cognito.UserPoolDomain(`${projectName}-userPoolDomain`, {
    domain: `${projectName}-auth`, 
    userPoolId: userPool.id,
}, { protect: true });



// User Pool Client with Hosted UI Configuration
const userPoolClient = new aws.cognito.UserPoolClient(`${projectName}-userPoolClient`, {
    userPoolId: userPool.id,
    generateSecret: false, // Disable secrets for public clients
    allowedOauthFlowsUserPoolClient: true,
    allowedOauthFlows: ["code", "implicit"], // Enable OAuth 2.0 flows
    allowedOauthScopes: ["openid", "profile", "email"], // Define OAuth scopes
    callbackUrls: callbackUrls, // URLs for redirect after login
    logoutUrls: logoutUrls, // URLs for redirect after logout
    explicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
        "ALLOW_USER_SRP_AUTH",
    ],
  
});
// Create an S3 Bucket for CloudTrail Logs
const trailBucket = new aws.s3.Bucket(`${projectName}-cloudtrail-logs`, {
    acl: "private",
    forceDestroy: true, // For testing; remove in production
    serverSideEncryptionConfiguration: {
        rule: {
            applyServerSideEncryptionByDefault: {
                sseAlgorithm: "AES256",
            },
        },
    },
});

const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(`${projectName}-public-access-block`, {
    bucket: trailBucket.id,
    blockPublicAcls: false,
    blockPublicPolicy: false,
    ignorePublicAcls: false,
    restrictPublicBuckets: false,
});


// Allow CloudTrail to write to the bucket
const bucketPolicy = new aws.s3.BucketPolicy(`${projectName}-trail-bucket-policy`, {
    bucket: trailBucket.id,
    policy: trailBucket.id.apply(bucketName => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Sid: "AWSCloudTrailWrite",
                Effect: "Allow",
                Principal: {
                    Service: "cloudtrail.amazonaws.com",
                },
                Action: "s3:PutObject",
                Resource: `arn:aws:s3:::${bucketName}/*`, // Object-level permission
                Condition: {
                    StringEquals: {
                        "s3:x-amz-acl": "bucket-owner-full-control",
                    },
                },
            },
            {
                Sid: "AllowBucketOwnerAccess",
                Effect: "Allow",
                Principal: "*",
                Action: ["s3:GetBucketAcl", "s3:ListBucket"],
                Resource: `arn:aws:s3:::${bucketName}`, // Bucket-level permission
            },
        ],
    })),
});



// Create the CloudTrail Trail
const trail = new aws.cloudtrail.Trail(`${projectName}-trail`, {
    s3BucketName: trailBucket.id,
    includeGlobalServiceEvents: false, // Captures global events
    enableLogFileValidation: true,
    isMultiRegionTrail: false, // Captures events across all regions
    eventSelectors: [
        {
            readWriteType: "All",
            includeManagementEvents: true, // Log API management calls
        },
    ],
}, { dependsOn: [bucketPolicy] });

// EventBridge Rule for Cognito User Confirmation
const userConfirmationRule = new aws.cloudwatch.EventRule(`${projectName}-userConfirmationRule`, {
    eventPattern: JSON.stringify({
        source: ["aws.cognito-idp"],
        "detail-type": ["AWS API Call via CloudTrail"],
        detail: {
            eventSource: ["cognito-idp.amazonaws.com"],
            eventName: ["AdminConfirmSignUp", "ConfirmSignUp"],
        },
    }),
});


// Retrieve the default VPC and its subnets
const defaultVpc = aws.ec2.getVpc({ default: true });
const defaultSubnets = defaultVpc.then(vpc =>
    aws.ec2.getSubnets({
        filters: [{ name: "vpc-id", values: [vpc.id] }], 
    })
);


// RDS Security Group
const rdsSecurityGroup = new aws.ec2.SecurityGroup(`${projectName}-rds-sg`, {
    vpcId: defaultVpc.then(vpc => vpc.id),
    ingress: [
        {
            protocol: "tcp",
            fromPort: 5432,
            toPort: 5432,
            cidrBlocks: ["172.31.0.0/16", "98.5.181.119/32"], 
        },
    ],
    egress: [
        {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
});

// Lambda Security Group
const lambdaSecurityGroup = new aws.ec2.SecurityGroup(`${projectName}-lambda-sg`, {
    vpcId: defaultVpc.then(vpc => vpc.id),
    ingress: [],
    egress: [
        {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
});

const rdsSubnetGroup = new aws.rds.SubnetGroup(`${projectName}-rds-subnet-group`, {
    subnetIds: defaultSubnets.then(subnets => subnets.ids),
    tags: { Name: `${projectName}-rds-subnet-group` },
});






// Provision the PostgreSQL Database
const dbInstance = new aws.rds.Instance(`${projectName}-postgresinstance`, {
    engine: "postgres",
    engineVersion: "17.2",
    instanceClass: "db.t3.micro",
    allocatedStorage: 20,
    dbName: dbName,
    username: dbUsername,
    password: dbPassword,
    dbSubnetGroupName: rdsSubnetGroup.name,
    vpcSecurityGroupIds: [rdsSecurityGroup.id],
    skipFinalSnapshot: true,
    publiclyAccessible: true, // For testing purposes; disable in production
});


// Lambda Role
const lambdaRole = new aws.iam.Role(`${projectName}-lambdaRole`, {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Principal: {
                    Service: "lambda.amazonaws.com",
                },
                Action: "sts:AssumeRole",
            },
        ],
    }),
});

// Attach Execution Role
new aws.iam.RolePolicyAttachment(`${projectName}-lambdaBasicExecution`, {
    role: lambdaRole.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

//Define VPC Policy
const lambdaVpcPolicy = new aws.iam.Policy(`${projectName}-lambdaVpcPolicy`, {
    description: "Policy to allow Lambda to work in a VPC",
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "ec2:CreateNetworkInterface",
                    "ec2:DescribeNetworkInterfaces",
                    "ec2:DeleteNetworkInterface",
                    "ec2:AssignPrivateIpAddresses",
                    "ec2:UnassignPrivateIpAddresses"
                ],
                Resource: "*"
            }
        ]
    }),
});

// Add VPC policy to lambda role
new aws.iam.RolePolicyAttachment(`${projectName}-lambdaVpcPolicyAttachment`, {
    role: lambdaRole.name,
    policyArn: lambdaVpcPolicy.arn,
});




// Define the policy for Cognito permissions
const cognitoPolicy = new aws.iam.Policy(`${projectName}-cognitoPolicy`, {
    description: "Policy to allow Lambda access to Cognito AdminGetUser",
    policy: pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": ["cognito-idp:AdminGetUser", "cognito-idp:ListUsers"],
                "Resource": "arn:aws:cognito-idp:${awsRegion}:${aws.getCallerIdentityOutput().accountId}:userpool/${userPool.id}"
            }
        ]
    }`,
});

// Attach the Cognito policy to the Lambda role
new aws.iam.RolePolicyAttachment(`${projectName}-cognitoPolicyAttachment`, {
    role: lambdaRole.name,
    policyArn: cognitoPolicy.arn,
});



// Define Postgres Lambda Layer
const pgLayer = new aws.lambda.LayerVersion("psycopg2-layer", {
    layerName: "psycopg2-layer", 
    compatibleRuntimes: ["python3.9"], 
    code: new pulumi.asset.FileArchive("./psycopg2-layer.zip"), 
});



// Second Lambda Function (Add User to Database)
const addUserToDbLambda = new aws.lambda.Function(`${projectName}-addUserToDb`, {
    runtime: "python3.9",
    handler: "index.lambda_handler",
    layers: [pgLayer.arn],
    role: lambdaRole.arn,
    code: new pulumi.asset.AssetArchive({
        ".": new pulumi.asset.FileArchive("./user-addition-lambda-code"),
    }),
    timeout: 180,
    environment: {
        variables: {
            DB_HOST: dbInstance.endpoint.apply(endpoint => endpoint.split(":")[0]), // Extract hostname,
            DB_USER: dbUsername,
            DB_PASSWORD: dbPassword.apply(password => password),
            DB_NAME: dbName,
        },
    },
    vpcConfig: {
        subnetIds: defaultSubnets.then(subnets => subnets.ids),
        securityGroupIds: [rdsSecurityGroup.id],
    },
});

// First Lambda Function (Fetch Cognito User)
const fetchCognitoUserLambda = new aws.lambda.Function(`${projectName}-fetchCognitoUser`, {
    runtime: "python3.9",
    handler: "index.lambda_handler",
    role: lambdaRole.arn,
    code: new pulumi.asset.AssetArchive({
        ".": new pulumi.asset.FileArchive("./confirmation-handler-lambda-code"),
    }),
    timeout: 180,
    environment: {
        variables: {
            COGNITO_USER_POOL_ID: userPool.id,
            TARGET_LAMBDA_ARN: addUserToDbLambda.arn,
        },
    },
});


// EventBridge Rule Target
const userConfirmationTarget = new aws.cloudwatch.EventTarget(`${projectName}-userConfirmationTarget`, {
    rule: userConfirmationRule.name,
    arn: fetchCognitoUserLambda.arn,
});

// Grant EventBridge Permission to Invoke Lambda
new aws.lambda.Permission(`${projectName}-eventPermission`, {
    action: "lambda:InvokeFunction",
    function: fetchCognitoUserLambda.name,
    principal: "events.amazonaws.com",
    sourceArn: userConfirmationRule.arn,
});

// Add Permission for First Lambda to Invoke Second Lambda
const invokeFunctionPolicy = new aws.iam.Policy(`${projectName}-invokeFunctionPolicy`, {
    description: "Allows the fetchCognitoUser Lambda to invoke the addUserToDb Lambda",
    policy: pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "lambda:InvokeFunction",
                "Resource": "${addUserToDbLambda.arn}"
            }
        ]
    }`,
});

new aws.iam.RolePolicyAttachment(`${projectName}-invokeFunctionPolicyAttachment`, {
    role: lambdaRole.name,
    policyArn: invokeFunctionPolicy.arn,
});


new aws.lambda.Permission(`${projectName}-invokeAddUserToDbPermission`, {
    action: "lambda:InvokeFunction",
    function: addUserToDbLambda.name,
    principal: "lambda.amazonaws.com",
    sourceAccount: awsAccountId, 
});





// Export Outputs
export const cognitoUserPoolId = userPool.id;
export const cognitoUserPoolClientId = userPoolClient.id;
export const cognitoHostedUiUrl = pulumi.interpolate`https://${userPoolDomain.domain}.auth.${aws.config.region}.amazoncognito.com/login?client_id=${userPoolClient.id}&response_type=code&scope=openid+profile+email&redirect_uri=${callbackUrls[0]}`;
export const rdsEndpoint = dbInstance.endpoint;
export const rdsUsername = dbInstance.username;
export const eventRuleName = userConfirmationRule.name;
export const trailArn = trail.arn;
export const trailBucketName = trailBucket.bucket;
export const fetchCognitoUserLambdaArn = fetchCognitoUserLambda.arn;