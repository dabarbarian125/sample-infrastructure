import os
import boto3
import json

def lambda_handler(event, context):
    # Extract environment variables
    cognito_user_pool_id = os.environ['COGNITO_USER_POOL_ID']
    target_lambda_arn = os.environ['TARGET_LAMBDA_ARN']
    
    try:
        # Initialize Cognito client
        cognito_client = boto3.client('cognito-idp')
        lambda_client = boto3.client('lambda')

        # Extract user sub or username from the event
        user_sub = event.get("detail", {}).get("additionalEventData", {}).get("sub")
        if not user_sub:
            raise ValueError("User sub not found in event data.")

        # Fetch user attributes from Cognito
        response = cognito_client.admin_get_user(
            UserPoolId=cognito_user_pool_id,
            Username=user_sub
        )

        # Parse Cognito response to extract email and username
        user_attributes = {attr['Name']: attr['Value'] for attr in response['UserAttributes']}
        email = user_attributes.get('email')
        username = user_attributes.get('preferred_username', user_sub)  # Fallback to sub if no username

        if not email or not username:
            raise ValueError("Required fields username or email are missing in Cognito data.")

        # Prepare the payload for the second Lambda function
        payload = {
            "username": username,
            "email": email
        }

        # Invoke the second Lambda function
        lambda_client.invoke(
            FunctionName=target_lambda_arn,
            InvocationType='Event',  # Asynchronous invocation
            Payload=json.dumps(payload)
        )

        print(f"User {username} with email {email} fetched successfully and passed to the second Lambda.")
        return {
            "statusCode": 200,
            "body": json.dumps({"message": f"User {username} fetched successfully."})
        }
    except Exception as e:
        print(f"Error: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }

