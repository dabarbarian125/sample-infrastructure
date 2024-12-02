import os
import sys
import boto3
import psycopg2
import json

def lambda_handler(event, context):
    print(event)
    # Extract environment variables
    db_host = os.environ['DB_HOST']
    db_user = os.environ['DB_USER']
    db_password = os.environ['DB_PASSWORD']
    db_name = os.environ['DB_NAME']
    cognito_user_pool_id = os.environ['COGNITO_USER_POOL_ID']
    connection = None
    
    try:
        # Initialize Cognito client
        cognito_client = boto3.client('cognito-idp')
        
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

        # Connect to the PostgreSQL database
        connection = psycopg2.connect(
            host=db_host,
            user=db_user,
            password=db_password,
            dbname=db_name
        )
        cursor = connection.cursor()

        # Create the user table if it does not exist
        create_table_query = """
            CREATE TABLE IF NOT EXISTS "users" (
                id SERIAL PRIMARY KEY,
                "username" VARCHAR NOT NULL,
                email VARCHAR NOT NULL
            )
        """
        cursor.execute(create_table_query)

        # Insert user data into the table
        insert_query = """
            INSERT INTO "users" ("username", email)
            VALUES (%s, %s)
        """
        cursor.execute(insert_query, (username, email))
        connection.commit()

        print(f"User {username} with email {email} added successfully.")
        return {
            "statusCode": 200,
            "body": json.dumps({"message": f"User {username} added successfully."})
        }
    except Exception as e:
        print(f"Error: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
    finally:
        if connection:
            cursor.close()
            connection.close()

